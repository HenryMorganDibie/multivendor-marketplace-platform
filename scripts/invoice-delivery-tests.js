/**
 * Acceptance for the invoice work raised in review: editing, deletion,
 * cancellation, and delivery into a conversation.
 *
 * Each of these had a button in the app and nothing behind it. The tests are
 * written against the behaviour a vendor would notice, not against the shape of
 * the documents.
 *
 * Run:  node invoice-delivery-tests.js   (with the emulator running)
 */
process.env.GCLOUD_PROJECT = "demo-platform";
process.env.GOOGLE_CLOUD_PROJECT = "demo-platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

const admin = require("firebase-admin");
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, connectAuthEmulator } = require("firebase/auth");
const { getFunctions, httpsCallable, connectFunctionsEmulator } = require("firebase/functions");

if (!admin.apps.length) admin.initializeApp({ projectId: "demo-platform" });
const fdb = admin.firestore();

const client = initializeApp({ apiKey: "demo", projectId: "demo-platform" }, `inv-${Date.now()}`);
const auth = getAuth(client);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const fns = getFunctions(client);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

let pass = 0, fail = 0;
const check = (n, label, ok, detail) => {
  if (ok) { pass++; console.log(`PASS  ${n}. ${label}`); }
  else { fail++; console.log(`FAIL  ${n}. ${label}${detail ? `  (${detail})` : ""}`); }
};

async function makeInvoice(vendorId, extra = {}) {
  const ref = fdb.collection("invoices").doc();
  await ref.set({
    invoiceId: ref.id, invoiceNumber: `INV-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    vendorId, customerId: null, conversationId: null,
    customerName: "Test Customer", lineItems: [{ description: "Item", quantity: 1, unitPrice: 500000 }],
    subtotal: 500000, currency: "NGN", status: "unpaid",
    hiddenFromHistory: false, shareToken: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: admin.firestore.Timestamp.now(),
    ...extra,
  });
  return ref;
}

async function main() {
  await signInWithEmailAndPassword(auth, "demo.vendor@example.com", "DemoPass123!");
  const token = await auth.currentUser.getIdTokenResult(true);
  const vendorId = token.claims.vendorId;

  // ── Editing ───────────────────────────────────────────────────────────────
  const draft = await makeInvoice(vendorId);
  await httpsCallable(fns, "updateInvoice")({
    invoiceId: draft.id, customerName: "Renamed Customer",
    lineItems: [{ description: "Item", quantity: 2, unitPrice: 500000 }],
  });
  const edited = (await draft.get()).data();
  check(1, "An undelivered draft can have its items and total changed",
    edited.subtotal === 1000000 && edited.customerName === "Renamed Customer",
    `subtotal ${edited.subtotal}`);

  /**
   * A sent but unpaid invoice is still a proposal.
   *
   * This originally asserted the opposite — that delivery locked the figures —
   * on the reasoning that changing an amount someone already holds is a
   * different invoice. That is not how this gets used: a customer asks for
   * three instead of two and the vendor revises it. Nothing is paid, so there
   * is no history to protect, and forcing cancel-and-reissue would leave a
   * cancelled row for every negotiation.
   */
  const sent = await makeInvoice(vendorId, { sentInChatAt: admin.firestore.Timestamp.now(), chatId: "chat_x" });
  await httpsCallable(fns, "updateInvoice")({
    invoiceId: sent.id, lineItems: [{ description: "Item", quantity: 9, unitPrice: 100000 }],
  });
  const revised = (await sent.get()).data();
  check(2, "A sent but unpaid invoice can still have its items changed",
    revised.subtotal === 900000, `subtotal ${revised.subtotal}`);

  // The customer's copy resolves live, but nothing would tell them to look
  // again. A revision to something already delivered has to be visible as one.
  check(2.1, "Revising a delivered invoice marks it as revised",
    revised.revisionCount >= 1 && Boolean(revised.revisedAt),
    `revisionCount ${revised.revisionCount}`);

  // Contact details are not money, so they stay editable after delivery.
  await httpsCallable(fns, "updateInvoice")({ invoiceId: sent.id, customerPhone: "+2348011122233" });
  check(3, "A delivered invoice still accepts contact detail corrections",
    (await sent.get()).data().customerPhone === "+2348011122233");

  // Anything with money against it is closed to edits.
  const paid = await makeInvoice(vendorId);
  await httpsCallable(fns, "recordPayment")({
    invoiceId: paid.id, amountMinorUnits: 500000, method: "cash", idempotencyKey: `k_${Date.now()}`,
  });
  let paidRefused = null;
  try {
    await httpsCallable(fns, "updateInvoice")({ invoiceId: paid.id, customerName: "Nope" });
  } catch (e) { paidRefused = e.code; }
  check(4, "An invoice with a payment against it refuses all edits",
    Boolean(paidRefused?.includes("failed-precondition")), paidRefused ?? "it was allowed");

  // ── Deletion ──────────────────────────────────────────────────────────────
  const deletable = await makeInvoice(vendorId);
  await httpsCallable(fns, "deleteInvoice")({ invoiceId: deletable.id });
  check(5, "A draft nobody has seen is deleted outright", !(await deletable.get()).exists);

  let sentDeleteRefused = null;
  try { await httpsCallable(fns, "deleteInvoice")({ invoiceId: sent.id }); }
  catch (e) { sentDeleteRefused = e.code; }
  check(6, "A delivered invoice cannot be deleted, only cancelled",
    Boolean(sentDeleteRefused?.includes("failed-precondition")), sentDeleteRefused ?? "it was allowed");

  let paidDeleteRefused = null;
  try { await httpsCallable(fns, "deleteInvoice")({ invoiceId: paid.id }); }
  catch (e) { paidDeleteRefused = e.code; }
  check(7, "An invoice with payments cannot be deleted",
    Boolean(paidDeleteRefused?.includes("failed-precondition")), paidDeleteRefused ?? "it was allowed");

  // ── Delivery into a conversation ──────────────────────────────────────────
  const thread = fdb.collection("chatThreads").doc();
  await thread.set({
    chatId: thread.id, vendorId, customerId: "cust_chat_1",
    participants: [vendorId, "cust_chat_1"], chatType: "inquiry",
    relatedOrderIds: [], createdAt: admin.firestore.Timestamp.now(),
  });

  const toSend = await makeInvoice(vendorId, { customerId: "cust_chat_1" });
  const sendRes = await httpsCallable(fns, "sendInvoiceInChat")({
    invoiceId: toSend.id, chatId: thread.id,
  });
  check(8, "Sending an invoice into a chat succeeds", sendRes.data.success === true);

  const msgs = await thread.collection("messages").where("type", "==", "invoice").get();
  check(9, "An invoice card is actually posted into the conversation",
    msgs.size === 1, `${msgs.size} invoice messages`);

  const card = msgs.docs[0]?.data();
  check(10, "The card carries server-assembled figures, not client-supplied ones",
    card?.invoiceData?.subtotal === 500000 && card?.invoiceData?.invoiceId === toSend.id,
    JSON.stringify(card?.invoiceData ?? {}).slice(0, 90));

  const bound = (await toSend.get()).data();
  check(11, "The invoice is bound to the conversation so Open chat can work",
    bound.chatId === thread.id && Boolean(bound.sentInChatAt), `chatId ${bound.chatId}`);

  // Tapping send twice must not put two demands for the same money in a chat.
  const again = await httpsCallable(fns, "sendInvoiceInChat")({
    invoiceId: toSend.id, chatId: thread.id,
  });
  const msgsAfter = await thread.collection("messages").where("type", "==", "invoice").get();
  check(12, "Sending the same invoice twice does not post a second card",
    again.data.alreadySent === true && msgsAfter.size === 1, `${msgsAfter.size} cards`);

  // ── Ownership ─────────────────────────────────────────────────────────────
  const foreign = await makeInvoice("some_other_vendor");
  let foreignRefused = null;
  try { await httpsCallable(fns, "sendInvoiceInChat")({ invoiceId: foreign.id, chatId: thread.id }); }
  catch (e) { foreignRefused = e.code; }
  check(13, "A vendor cannot send another vendor's invoice",
    Boolean(foreignRefused?.includes("permission-denied")), foreignRefused ?? "it was allowed");

  const foreignThread = fdb.collection("chatThreads").doc();
  await foreignThread.set({
    chatId: foreignThread.id, vendorId: "some_other_vendor", customerId: "cust_x",
    participants: ["some_other_vendor", "cust_x"], chatType: "inquiry",
    relatedOrderIds: [], createdAt: admin.firestore.Timestamp.now(),
  });
  const mine = await makeInvoice(vendorId);
  let threadRefused = null;
  try { await httpsCallable(fns, "sendInvoiceInChat")({ invoiceId: mine.id, chatId: foreignThread.id }); }
  catch (e) { threadRefused = e.code; }
  check(14, "A vendor cannot post into a conversation that is not theirs",
    Boolean(threadRefused?.includes("permission-denied")), threadRefused ?? "it was allowed");

  await foreign.delete();
  await foreignThread.delete();

  console.log(`\n${fail === 0 ? "ALL INVOICE DELIVERY TESTS PASSED" : `${fail} FAILURE(S)`}  (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
