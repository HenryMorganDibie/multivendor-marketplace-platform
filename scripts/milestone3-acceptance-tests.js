/**
 * THE PLATFORM — Milestone 3 Acceptance Test Suite
 * Commerce chat, notifications, blocks, pickup auto-send, drafts,
 * greeting/away messages, quick replies, country availability.
 *
 * Run: node milestone3-acceptance-tests.js
 * Requires: firebase emulators:start --only auth,firestore,functions,storage --project demo-the platform
 */
const PROJECT_ID = "demo-the platform";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
process.env.FUNCTIONS_EMULATOR = "true";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` });

const { initializeApp, getApps } = require("firebase/app");
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require("firebase/auth");
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, collection, getDocs, query } = require("firebase/firestore");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const { getStorage, connectStorageEmulator, ref, uploadBytes } = require("firebase/storage");

const clientApp = getApps().find(a => a.name === "test3") || initializeApp({ apiKey: "demo", projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }, "test3");
const auth = getAuth(clientApp), db = getFirestore(clientApp), fns = getFunctions(clientApp), storage = getStorage(clientApp);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
connectStorageEmulator(storage, "127.0.0.1", 9199);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0, total = 0;
async function test(name, fn) {
  total++;
  try { await fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message ?? e}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || "Assertion failed"); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(m || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function assertDenied(p) {
  return p.then(() => { throw new Error("Expected denial but succeeded"); }, err => {
    if (!err.code?.includes("permission-denied") && !err.message?.includes("permission-denied") && !err.code?.includes("PERMISSION_DENIED") && !err.code?.includes("failed-precondition")) throw new Error(`Expected denial, got: ${err.code} — ${err.message}`);
  });
}
async function assertFnError(p, code) {
  return p.then(() => { throw new Error(`Expected ${code} but succeeded`); }, err => {
    if (!err.code?.includes(code)) throw new Error(`Expected ${code}, got: ${err.code} — ${err.message}`);
  });
}
async function waitFor(fn, retries = 15, delay = 1000) {
  for (let i = 0; i < retries; i++) { const r = await fn(); if (r) return r; await sleep(delay); }
  throw new Error("waitFor: condition never met");
}

const PASSWORD = "TestPass123!";
let vendorEmail, vendorUid, vendorId, customerEmail, customerUid, adminEmail, adminUid;
let catalogItemId, chatId, secondCustomerEmail, secondCustomerUid;

async function signInAs(email) { const c = await signInWithEmailAndPassword(auth, email, PASSWORD); await c.user.getIdToken(true); return c; }

async function seedCountryAvailability() {
  await admin.firestore().collection("countryAvailability").doc("NG").set({
    countryCode: "NG",
    countryName: "Nigeria",
    status: "ACTIVE",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: "manual_phase_3_seed",
  });
}

async function setup() {
  console.log("\n⚙️  Setup: provisioning test accounts...");
  await seedCountryAvailability();

  customerEmail = `p3cust_${Date.now()}@test.com`;
  const cc = await createUserWithEmailAndPassword(auth, customerEmail, PASSWORD);
  customerUid = cc.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", customerUid)); return s.exists() ? s : null; });

  secondCustomerEmail = `p3cust2_${Date.now()}@test.com`;
  const cc2 = await createUserWithEmailAndPassword(auth, secondCustomerEmail, PASSWORD);
  secondCustomerUid = cc2.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", secondCustomerUid)); return s.exists() ? s : null; });

  vendorEmail = `p3vend_${Date.now()}@test.com`;
  const vc = await createUserWithEmailAndPassword(auth, vendorEmail, PASSWORD);
  vendorUid = vc.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", vendorUid)); return s.exists() ? s : null; });
  await signInAs(vendorEmail);
  const rr = await httpsCallable(fns, "completeRegistration")({ role: "vendor", businessName: "Chat Test Vendor", username: `chatvend_${Date.now()}`, fullName: "Vendor Owner", categoryId: "food_catering", categoryName: "Food & Catering", country: "Nigeria", state: "Lagos", area: "Lekki", plan: "basic" });
  vendorId = rr.data.vendorId;
  await auth.currentUser.getIdToken(true);

  adminEmail = `p3admin_${Date.now()}@the platform.com`;
  const ac = await createUserWithEmailAndPassword(auth, adminEmail, PASSWORD);
  adminUid = ac.user.uid;
  await waitFor(async () => { const s = await getDoc(doc(db, "users", adminUid)); return s.exists() ? s : null; });
  await admin.auth().setCustomUserClaims(adminUid, { role: "admin", adminRoleIds: ["super_admin","verification_admin","safety_admin"], claimsVersion: 1 });
  await admin.firestore().collection("adminUsers").doc(adminUid).set({ uid: adminUid, email: adminEmail, roleIds: ["super_admin","verification_admin","safety_admin"], status: "active", mfaRequired: true, mfaEnrolled: false, createdByAdminUid: null, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), lastLoginAt: null, revokedAt: null, lastMfaAt: null });
  await admin.firestore().collection("users").doc(adminUid).update({ role: "admin" });

  await signInAs(vendorEmail);
  for (const type of ["business_info","identity_document","proof_of_address"]) {
    const path = `verificationDocuments/${vendorId}/${type}_setup.pdf`;
    await uploadBytes(ref(storage, path), new Uint8Array([0x25,0x50,0x44,0x46]), { contentType: "application/pdf" });
    await httpsCallable(fns, "recordVerificationDocument")({ type, storagePath: path });
  }
  await httpsCallable(fns, "submitVendorVerification")({});
  await signInAs(adminEmail);
  await httpsCallable(fns, "approveVendorVerification")({ vendorId });
  await sleep(1500);
  await signInAs(vendorEmail);
  await httpsCallable(fns, "setVendorPublishStatus")({ isPublished: true });
  await sleep(1500);

  // completeRegistration stores the raw country name (e.g. "Nigeria") in
  // countryCode, not the ISO code — always overwrite to the real code the
  // countryAvailability document is seeded under.
  const patch = { storefrontPublished: true, ownerUid: vendorUid, countryCode: "NG" };
  await admin.firestore().collection("vendors").doc(vendorId).update(patch);

  const itemResult = await httpsCallable(fns, "createCatalogItem")({ name: "Test Item", basePrice: 1500, currency: "NGN", isAvailable: true });
  catalogItemId = itemResult.data.itemId;
  await admin.firestore().collection("vendors").doc(vendorId).collection("catalogItems").doc(catalogItemId).update({ moderationStatus: "approved" });

  console.log(`  -> Vendor ${vendorId} ready, country NG seeded ACTIVE`);
}

async function section1() {
  console.log("\n📋 Section 1: Commerce conversation creation");

  await test("Customer can create a commerce conversation with a discoverable vendor", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    assert(r.data.success);
    assert(r.data.created === true, "First call should create the thread");
    chatId = r.data.chatId;
    assertEqual(chatId, `commerce_${customerUid}_${vendorId}`, "chatId must be deterministic");
  });

  await test("Calling createCommerceConversation again is idempotent (no duplicate)", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    assert(r.data.success);
    assertEqual(r.data.created, false, "Second call must not create a new thread");
    assertEqual(r.data.chatId, chatId);
  });

  await test("Thread has chatType commerce and correct participants", async () => {
    const snap = await admin.firestore().collection("chatThreads").doc(chatId).get();
    assertEqual(snap.data().chatType, "commerce");
    assert(snap.data().participants.includes(customerUid));
    assert(snap.data().participants.includes(vendorUid));
    assertEqual(snap.data().relatedOrderIds.length, 0, "No orders yet");
  });

  await test("Vendor can read the commerce thread", async () => {
    await signInAs(vendorEmail);
    const s = await getDoc(doc(db, "chatThreads", chatId));
    assert(s.exists());
  });

  await test("A different customer CANNOT read this thread", async () => {
    await signInAs(secondCustomerEmail);
    await assertDenied(getDoc(doc(db, "chatThreads", chatId)));
  });

  await test("Customer CANNOT directly write to chatThreads", async () => {
    await signInAs(customerEmail);
    await assertDenied(setDoc(doc(db, "chatThreads", chatId), { lastMessage: "hacked" }, { merge: true }));
  });

  await test("createCommerceConversation rejects unknown vendor", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "createCommerceConversation")({ vendorId: "nonexistent_vendor_id" }), "not-found");
  });

  await test("Vendor role CANNOT call createCommerceConversation (customer-only action)", async () => {
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "createCommerceConversation")({ vendorId }), "permission-denied");
  });
}

async function section2() {
  console.log("\n📋 Section 2: Sending messages");

  await test("Customer can send a text message", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "Hi, are you open today?" });
    assert(r.data.success);
    assert(r.data.messageId);
  });

  await test("Thread lastMessage/lastMessageAt updated after send", async () => {
    const snap = await admin.firestore().collection("chatThreads").doc(chatId).get();
    assertEqual(snap.data().lastMessage, "Hi, are you open today?");
    assertEqual(snap.data().lastSenderUid, customerUid);
  });

  await test("Vendor can reply with text", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "Yes! Open till 9pm." });
    assert(r.data.success);
  });

  await test("Non-participant CANNOT send a message", async () => {
    await signInAs(secondCustomerEmail);
    await assertFnError(httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "sneaky" }), "permission-denied");
  });

  await test("Client CANNOT create order_context message directly", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "sendChatMessage")({ chatId, type: "order_context", content: "fake order" }), "invalid-argument");
  });

  await test("Client CANNOT create pickup-details message directly", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "sendChatMessage")({ chatId, type: "pickup-details", content: "fake pickup" }), "invalid-argument");
  });

  await test("Client CANNOT create system message directly", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "sendChatMessage")({ chatId, type: "system", content: "fake system" }), "invalid-argument");
  });

  await test("Empty text message is rejected", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "   " }), "invalid-argument");
  });

  await test("Customer can share catalog_item — price is server-fetched not client-trusted", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({
      chatId, type: "catalog_item",
      catalogItemData: { itemId: catalogItemId, basePrice: 1 }, // client sends fake price=1
    });
    assert(r.data.success);
    const msgSnap = await admin.firestore().collection("chatThreads").doc(chatId).collection("messages").doc(r.data.messageId).get();
    assertEqual(msgSnap.data().catalogItemData.basePrice, 1500, "Server must use real catalog price, not client-supplied 1");
  });

  await test("Customer can share their own contact-card snapshot inline", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({
      chatId, type: "contact-card",
      contactCardData: { fullName: "Jane Doe", phoneNumber: "+2348011112222" },
    });
    assert(r.data.success);
    const msgSnap = await admin.firestore().collection("chatThreads").doc(chatId).collection("messages").doc(r.data.messageId).get();
    assertEqual(msgSnap.data().contactCardData.fullName, "Jane Doe");
  });

  await test("Message immutability — client CANNOT edit content after creation", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "original" });
    await assertDenied(
      setDoc(doc(db, "chatThreads", chatId, "messages", r.data.messageId), { content: "edited" }, { merge: true })
    );
  });

  await test("Attachment size limit enforced (max 15MB)", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "sendChatMessage")({
      chatId, type: "text", content: "with huge file",
      attachments: [{ storagePath: "x.jpg", contentType: "image/jpeg", sizeBytes: 20 * 1024 * 1024 }],
    }), "invalid-argument");
  });
}

async function section3() {
  console.log("\n📋 Section 3: Order context — same thread, no duplicate threads");

  let orderId1, orderId2;

  await test("Placing an order does NOT create a new thread — reuses existing commerce thread", async () => {
    const threadsBefore = await admin.firestore().collection("chatThreads")
      .where("customerId", "==", customerUid).where("vendorId", "==", vendorId).get();
    assertEqual(threadsBefore.size, 1, "Exactly 1 thread should exist before order");

    await signInAs(customerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItemId, quantity: 1 }] });
    const orderResult = await httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId });
    orderId1 = orderResult.data.orderId;
    assertEqual(orderResult.data.conversationId, chatId, "Order's conversationId must equal the existing thread's chatId");

    await sleep(500);
    const threadsAfter = await admin.firestore().collection("chatThreads")
      .where("customerId", "==", customerUid).where("vendorId", "==", vendorId).get();
    assertEqual(threadsAfter.size, 1, "Still exactly 1 thread after placing an order — no duplicate created");
  });

  await test("order_context system message was inserted into the thread", async () => {
    const msgsSnap = await admin.firestore().collection("chatThreads").doc(chatId).collection("messages")
      .where("type", "==", "order_context").get();
    assert(msgsSnap.size >= 1, "At least one order_context message must exist");
    const msg = msgsSnap.docs.find(d => d.data().orderId === orderId1);
    assert(msg, "order_context message must reference the correct orderId");
    assertEqual(msg.data().senderRole, "system");
  });

  await test("relatedOrderIds on the thread includes the new order", async () => {
    const snap = await admin.firestore().collection("chatThreads").doc(chatId).get();
    assert(snap.data().relatedOrderIds.includes(orderId1));
  });

  await test("A second order from the same customer/vendor reuses the SAME thread again", async () => {
    await signInAs(customerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItemId, quantity: 2 }] });
    const orderResult = await httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId });
    orderId2 = orderResult.data.orderId;
    assertEqual(orderResult.data.conversationId, chatId, "Second order must reuse the SAME conversationId");

    const threadsSnap = await admin.firestore().collection("chatThreads")
      .where("customerId", "==", customerUid).where("vendorId", "==", vendorId).get();
    assertEqual(threadsSnap.size, 1, "Still exactly 1 thread after a second order");

    const snap = await admin.firestore().collection("chatThreads").doc(chatId).get();
    assert(snap.data().relatedOrderIds.includes(orderId1));
    assert(snap.data().relatedOrderIds.includes(orderId2));
    assertEqual(snap.data().relatedOrderIds.length, 2, "Both orders distinguishable in relatedOrderIds");
  });

  await test("Concurrent createCommerceConversation calls do not create duplicate threads (race protection)", async () => {
    const raceCustomerEmail = `p3race_${Date.now()}@test.com`;
    const raceCred = await createUserWithEmailAndPassword(auth, raceCustomerEmail, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", raceCred.user.uid)); return s.exists() ? s : null; });
    await signInAs(raceCustomerEmail);

    const results = await Promise.allSettled([
      httpsCallable(fns, "createCommerceConversation")({ vendorId }),
      httpsCallable(fns, "createCommerceConversation")({ vendorId }),
      httpsCallable(fns, "createCommerceConversation")({ vendorId }),
    ]);
    const succeeded = results.filter(r => r.status === "fulfilled");
    assertEqual(succeeded.length, 3, "All 3 concurrent calls should succeed (idempotent)");

    const chatIds = succeeded.map(r => r.value.data.chatId);
    const uniqueChatIds = new Set(chatIds);
    assertEqual(uniqueChatIds.size, 1, "All 3 concurrent calls must resolve to the SAME chatId");

    const createdFlags = succeeded.map(r => r.value.data.created);
    const createdCount = createdFlags.filter(c => c === true).length;
    assertEqual(createdCount, 1, "Exactly 1 of the 3 concurrent calls should report created:true");
  });
}

async function section4() {
  console.log("\n📋 Section 4: Read receipts and drafts");

  await test("markChatRead writes a read receipt for the caller", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "markChatRead")({ chatId });
    assert(r.data.success);
    const receiptSnap = await admin.firestore().collection("chatThreads").doc(chatId).collection("readReceipts").doc(vendorUid).get();
    assert(receiptSnap.exists);
    assertEqual(receiptSnap.data().uid, vendorUid);
  });

  await test("User can only write their own read receipt", async () => {
    await signInAs(customerEmail);
    await assertDenied(
      setDoc(doc(db, "chatThreads", chatId, "readReceipts", vendorUid), { lastReadAt: new Date() }, { merge: true })
    );
  });

  await test("Messages from the other sender get marked read after markChatRead", async () => {
    await signInAs(customerEmail);
    await httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "checking read status" });
    await signInAs(vendorEmail);
    await httpsCallable(fns, "markChatRead")({ chatId });
    await sleep(500);
    const msgsSnap = await admin.firestore().collection("chatThreads").doc(chatId).collection("messages")
      .where("senderUid", "==", customerUid).orderBy("createdAt", "desc").limit(1).get();
    assertEqual(msgsSnap.docs[0].data().status, "read");
  });

  await test("Customer can save a chat draft", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "saveChatDraft")({ chatId, content: "typing something..." });
    assert(r.data.success);
    const draftSnap = await admin.firestore().collection("users").doc(customerUid).collection("chatDrafts").doc(chatId).get();
    assertEqual(draftSnap.data().content, "typing something...");
  });

  await test("Vendor CANNOT read customer's draft", async () => {
    await signInAs(vendorEmail);
    await assertDenied(getDoc(doc(db, "users", customerUid, "chatDrafts", chatId)));
  });

  await test("Sending an empty draft clears it", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "saveChatDraft")({ chatId, content: "" });
    assertEqual(r.data.cleared, true);
    const draftSnap = await admin.firestore().collection("users").doc(customerUid).collection("chatDrafts").doc(chatId).get();
    assert(!draftSnap.exists);
  });

  await test("clearChatDraft removes an existing draft", async () => {
    await signInAs(customerEmail);
    await httpsCallable(fns, "saveChatDraft")({ chatId, content: "draft to clear" });
    await httpsCallable(fns, "clearChatDraft")({ chatId });
    const draftSnap = await admin.firestore().collection("users").doc(customerUid).collection("chatDrafts").doc(chatId).get();
    assert(!draftSnap.exists);
  });
}

async function section5() {
  console.log("\n📋 Section 5: Blocks");

  let blockTestChatId, blockTestOrderId;

  await test("Setup: second customer starts a fresh commerce thread with the vendor", async () => {
    await signInAs(secondCustomerEmail);
    const r = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    blockTestChatId = r.data.chatId;
    assert(blockTestChatId);
  });

  await test("Customer can block the vendor", async () => {
    await signInAs(secondCustomerEmail);
    const r = await httpsCallable(fns, "blockUser")({ blockedUid: vendorUid, reason: "spam" });
    assert(r.data.success);
    const blockSnap = await admin.firestore().collection("blocks").doc(r.data.blockId).get();
    assert(blockSnap.exists);
    assertEqual(blockSnap.data().isActive, true);
    assert(blockSnap.data().blockedSnapshot.displayName, "Snapshot must include a display name");
  });

  await test("Only the blocker can read their blocked-list entry", async () => {
    await signInAs(secondCustomerEmail);
    const blockId = `${secondCustomerUid}_${vendorUid}`;
    const s = await getDoc(doc(db, "blocks", blockId));
    assert(s.exists());
  });

  await test("The blocked party CANNOT see themselves in the blocker's list (no read access to the block doc)", async () => {
    await signInAs(vendorEmail);
    const blockId = `${secondCustomerUid}_${vendorUid}`;
    await assertDenied(getDoc(doc(db, "blocks", blockId)));
  });

  await test("Blocked customer CANNOT start a new commerce conversation with a different vendor... wait, same vendor: new conversation already exists, so test NEW message send is blocked", async () => {
    await signInAs(secondCustomerEmail);
    await assertFnError(
      httpsCallable(fns, "sendChatMessage")({ chatId: blockTestChatId, type: "text", content: "still there?" }),
      "failed-precondition"
    );
  });

  await test("Blocked customer CANNOT place a new order with the vendor", async () => {
    await signInAs(secondCustomerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItemId, quantity: 1 }] });
    await assertFnError(httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId }), "failed-precondition");
  });

  await test("Unblock removes the restriction and messaging resumes", async () => {
    await signInAs(secondCustomerEmail);
    await httpsCallable(fns, "unblockUser")({ blockedUid: vendorUid });
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId: blockTestChatId, type: "text", content: "back again" });
    assert(r.data.success);
  });

  await test("Only the original blocker can unblock — re-block then try unblock from vendor side", async () => {
    await signInAs(secondCustomerEmail);
    await httpsCallable(fns, "blockUser")({ blockedUid: vendorUid });
    await signInAs(vendorEmail);
    await assertFnError(httpsCallable(fns, "unblockUser")({ blockedUid: secondCustomerUid }), "not-found");
    // vendor calling unblockUser looks for blockId `${vendorUid}_${secondCustomerUid}` which
    // was never created (the block was blocker=customer), so not-found is correct.
  });

  await test("EDGE CASE: block with an active order still allows messaging on that order until terminal", async () => {
    // Use the primary customer/vendor pair which has 2 active orders (orderId1, orderId2 from section 3)
    await signInAs(customerEmail);
    await httpsCallable(fns, "blockUser")({ blockedUid: vendorUid, reason: "testing active order exception" });

    // Existing thread messaging should STILL work because active orders exist
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "order still active, should work" });
    assert(r.data.success, "Messaging must remain allowed while an active order exists, even after blocking");
  });

  await test("EDGE CASE: but starting a brand NEW conversation is denied even with an active order elsewhere", async () => {
    // customerEmail already has a thread with vendorId — test via a hypothetical
    // second vendor scenario is out of scope for this harness; instead verify
    // that createOrderFromCart (new commerce) is denied despite active orders existing.
    await signInAs(customerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItemId, quantity: 1 }] });
    await assertFnError(
      httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId }),
      "failed-precondition"
    );
  });

  await test("EDGE CASE: once ALL active orders reach terminal status, messaging is blocked again", async () => {
    // Complete both active orders for the primary customer/vendor pair
    await signInAs(vendorEmail);
    // orderId1 was created with qty 1, orderId2 with qty 2 — accept and complete both
    const ordersSnap = await admin.firestore().collection("orders")
      .where("customerId", "==", customerUid).where("vendorId", "==", vendorId)
      .where("status", "==", "requested").get();

    for (const orderDoc of ordersSnap.docs) {
      await httpsCallable(fns, "updateOrderStatus")({ orderId: orderDoc.id, newStatus: "accepted" });
      await httpsCallable(fns, "updateOrderStatus")({ orderId: orderDoc.id, newStatus: "in_progress" });
      await httpsCallable(fns, "updateOrderStatus")({ orderId: orderDoc.id, newStatus: "completed" });
    }

    await signInAs(customerEmail);
    await assertFnError(
      httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "should fail now, all orders terminal" }),
      "failed-precondition"
    );
  });

  await test("Unblocking restores messaging after all-terminal block", async () => {
    await signInAs(customerEmail);
    await httpsCallable(fns, "unblockUser")({ blockedUid: vendorUid });
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "unblocked, works again" });
    assert(r.data.success);
  });
}

async function section6() {
  console.log("\n📋 Section 6: Notifications and push tokens");

  await test("Sending a message creates an in-app notification for the recipient", async () => {
    await signInAs(customerEmail);
    await httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "notify vendor please" });
    await sleep(500);
    const notifSnap = await admin.firestore().collection("users").doc(vendorUid).collection("notifications")
      .where("type", "==", "new_message").orderBy("createdAt", "desc").limit(1).get();
    assert(!notifSnap.empty, "Vendor should have received a new_message notification");
  });

  await test("Sender does NOT get notified of their own message", async () => {
    await signInAs(customerEmail);
    const beforeSnap = await admin.firestore().collection("users").doc(customerUid).collection("notifications")
      .where("type", "==", "new_message").get();
    const beforeCount = beforeSnap.size;
    await httpsCallable(fns, "sendChatMessage")({ chatId, type: "text", content: "self check" });
    await sleep(500);
    const afterSnap = await admin.firestore().collection("users").doc(customerUid).collection("notifications")
      .where("type", "==", "new_message").get();
    assertEqual(afterSnap.size, beforeCount, "Sender's own notification count must not increase");
  });

  await test("User can only read their own notifications", async () => {
    await signInAs(vendorEmail);
    await assertDenied(getDocs(collection(db, "users", customerUid, "notifications")));
  });

  await test("markNotificationRead sets read:true and readAt", async () => {
    await signInAs(vendorEmail);
    const notifSnap = await admin.firestore().collection("users").doc(vendorUid).collection("notifications")
      .orderBy("createdAt", "desc").limit(1).get();
    const notifId = notifSnap.docs[0].id;
    const r = await httpsCallable(fns, "markNotificationRead")({ notificationId: notifId });
    assert(r.data.success);
    const updated = await admin.firestore().collection("users").doc(vendorUid).collection("notifications").doc(notifId).get();
    assertEqual(updated.data().read, true);
  });

  await test("Client CANNOT directly create a notification document", async () => {
    await signInAs(customerEmail);
    await assertDenied(
      setDoc(doc(db, "users", customerUid, "notifications", "fake_notif"), { title: "fake", read: false })
    );
  });

  await test("Client can only update read/readAt on their notification, not title/body", async () => {
    await signInAs(vendorEmail);
    const notifSnap = await admin.firestore().collection("users").doc(vendorUid).collection("notifications")
      .orderBy("createdAt", "desc").limit(1).get();
    const notifId = notifSnap.docs[0].id;
    await assertDenied(
      setDoc(doc(db, "users", vendorUid, "notifications", notifId), { title: "HACKED TITLE" }, { merge: true })
    );
  });

  await test("registerPushToken stores a token under the caller's own uid", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "registerPushToken")({ token: "ExponentPushToken[abc123]", platform: "ios", deviceId: "device1" });
    assert(r.data.success);
    const tokenSnap = await admin.firestore().collection("users").doc(customerUid).collection("pushTokens").doc("device1").get();
    assertEqual(tokenSnap.data().token, "ExponentPushToken[abc123]");
    assertEqual(tokenSnap.data().enabled, true);
  });

  await test("User CANNOT write a push token for another user", async () => {
    await signInAs(customerEmail);
    await assertDenied(
      setDoc(doc(db, "users", vendorUid, "pushTokens", "hacked"), { token: "evil", platform: "ios", enabled: true })
    );
  });

  await test("Vendor notification preferences default correctly and securityAlerts cannot be disabled", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateVendorNotificationPreferences")({ pushEnabled: false, securityAlerts: false });
    const prefSnap = await admin.firestore().collection("vendors").doc(vendorId).collection("settings").doc("notifications").get();
    assertEqual(prefSnap.data().pushEnabled, false, "pushEnabled should update");
    assertEqual(prefSnap.data().securityAlerts, true, "securityAlerts must remain true regardless of client input");
  });

  await test("Customer notification preferences can be updated", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "updateCustomerNotificationPreferences")({ promotions: true, cartReminders: true });
    assert(r.data.success);
    const prefSnap = await admin.firestore().collection("users").doc(customerUid).collection("settings").doc("notifications").get();
    assertEqual(prefSnap.data().promotions, true);
  });

  await test("Vendor notification preferences are not directly writable by client", async () => {
    await signInAs(vendorEmail);
    await assertDenied(
      setDoc(doc(db, "vendors", vendorId, "settings", "notifications"), { pushEnabled: true }, { merge: true })
    );
  });
}

async function section7() {
  console.log("\n📋 Section 7: Greeting, away message, quick replies");

  await test("Vendor can enable a greeting message", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateVendorChatSettings")({ greetingEnabled: true, greetingMessage: "Welcome! Thanks for reaching out." });
    assert(r.data.success);
  });

  await test("Greeting message sends exactly once on first conversation creation", async () => {
    const greetCustomerEmail = `p3greet_${Date.now()}@test.com`;
    const greetCred = await createUserWithEmailAndPassword(auth, greetCustomerEmail, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", greetCred.user.uid)); return s.exists() ? s : null; });
    await signInAs(greetCustomerEmail);

    const r = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    await sleep(500);
    const msgsSnap = await admin.firestore().collection("chatThreads").doc(r.data.chatId).collection("messages")
      .where("systemSubtype", "==", "greeting_message").get();
    assertEqual(msgsSnap.size, 1, "Exactly one greeting message must exist");
    assertEqual(msgsSnap.docs[0].data().content, "Welcome! Thanks for reaching out.");

    // Sending more messages must NOT trigger another greeting
    await httpsCallable(fns, "sendChatMessage")({ chatId: r.data.chatId, type: "text", content: "another message" });
    const msgsAfter = await admin.firestore().collection("chatThreads").doc(r.data.chatId).collection("messages")
      .where("systemSubtype", "==", "greeting_message").get();
    assertEqual(msgsAfter.size, 1, "Greeting must not resend on subsequent messages");
  });

  await test("Empty greetingMessage with greetingEnabled=true sends nothing", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateVendorChatSettings")({ greetingEnabled: true, greetingMessage: "" });

    const emptyGreetEmail = `p3emptygreet_${Date.now()}@test.com`;
    const cred = await createUserWithEmailAndPassword(auth, emptyGreetEmail, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", cred.user.uid)); return s.exists() ? s : null; });
    await signInAs(emptyGreetEmail);
    const r = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    await sleep(500);
    const msgsSnap = await admin.firestore().collection("chatThreads").doc(r.data.chatId).collection("messages")
      .where("systemSubtype", "==", "greeting_message").get();
    assertEqual(msgsSnap.size, 0, "No greeting should send when message text is empty");

    // Restore for later tests
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateVendorChatSettings")({ greetingMessage: "Welcome back!" });
  });

  await test("Greeting message rejects text over 300 characters", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "updateVendorChatSettings")({ greetingMessage: "x".repeat(301) }),
      "invalid-argument"
    );
  });

  await test("Away message sends as a system message with cooldown", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateVendorChatSettings")({ awayMessageEnabled: true, awayMessage: "We are away, back soon!", awayCooldownHours: 12 });

    const awayCustomerEmail = `p3away_${Date.now()}@test.com`;
    const cred = await createUserWithEmailAndPassword(auth, awayCustomerEmail, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", cred.user.uid)); return s.exists() ? s : null; });
    await signInAs(awayCustomerEmail);
    const convResult = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    const awayChatId = convResult.data.chatId;

    await httpsCallable(fns, "sendChatMessage")({ chatId: awayChatId, type: "text", content: "hello?" });
    await sleep(800);

    const awayMsgs = await admin.firestore().collection("chatThreads").doc(awayChatId).collection("messages")
      .where("systemSubtype", "==", "away_message").get();
    assertEqual(awayMsgs.size, 1, "Away message must send once");

    // Second message within cooldown should NOT trigger another away message
    await httpsCallable(fns, "sendChatMessage")({ chatId: awayChatId, type: "text", content: "still there?" });
    await sleep(500);
    const awayMsgsAfter = await admin.firestore().collection("chatThreads").doc(awayChatId).collection("messages")
      .where("systemSubtype", "==", "away_message").get();
    assertEqual(awayMsgsAfter.size, 1, "Away message must not resend within cooldown window");

    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateVendorChatSettings")({ awayMessageEnabled: false });
  });

  await test("Vendor can create a quick reply", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createQuickReply")({ title: "Opening hours", shortcut: "/hours", message: "We are open 9am-9pm daily." });
    assert(r.data.success);
    const replySnap = await admin.firestore().collection("vendors").doc(vendorId).collection("quickReplies").doc(r.data.replyId).get();
    assertEqual(replySnap.data().shortcut, "/hours");
  });

  await test("Quick reply shortcut normalizes to start with /", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createQuickReply")({ title: "Location", shortcut: "location", message: "We are in Lekki Phase 1." });
    const replySnap = await admin.firestore().collection("vendors").doc(vendorId).collection("quickReplies").doc(r.data.replyId).get();
    assertEqual(replySnap.data().shortcut, "/location");
  });

  await test("Duplicate shortcut is rejected", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "createQuickReply")({ title: "Dup", shortcut: "/hours", message: "duplicate" }),
      "already-exists"
    );
  });

  await test("Customer CANNOT read vendor quick replies directly", async () => {
    await signInAs(customerEmail);
    await assertDenied(getDocs(collection(db, "vendors", vendorId, "quickReplies")));
  });

  await test("Quick reply is manual only — selecting it does not auto-send, only sendChatMessage sends", async () => {
    // This is architecturally guaranteed: there is no callable that sends
    // a quick reply directly. Verify no such function is exported by
    // checking it 404s as an unknown function.
    await signInAs(vendorEmail);
    try {
      await httpsCallable(fns, "sendQuickReply")({ chatId, replyId: "anything" });
      throw new Error("sendQuickReply should not exist as a callable");
    } catch (e) {
      assert(e.code === "functions/not-found" || e.code === "functions/internal" || e.message.includes("NOT_FOUND"),
        `Expected not-found style error, got: ${e.code} — ${e.message}`);
    }
  });

  await test("Vendor can delete a quick reply", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createQuickReply")({ title: "Temp", shortcut: "/temp", message: "temporary" });
    await httpsCallable(fns, "deleteQuickReply")({ replyId: r.data.replyId });
    const snap = await admin.firestore().collection("vendors").doc(vendorId).collection("quickReplies").doc(r.data.replyId).get();
    assert(!snap.exists);
  });
}

async function section8() {
  console.log("\n📋 Section 8: Pickup details auto-send");

  await test("Setup: upgrade vendor to Pro (auto-send pickup details is Pro+ only per Milestone 4's plan gating, added after this script was written)", async () => {
    await signInAs(adminEmail);
    await httpsCallable(fns, "applyManualSubscriptionOverride")({ vendorId, plan: "pro", reason: "milestone3 pickup-auto-send test fixture" });
  });

  await test("Vendor cannot enable auto-send without pickup address/instructions", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "updateVendorPickupSettings")({ autoSendPickupDetailsEnabled: true }),
      "failed-precondition"
    );
  });

  await test("Vendor can save pickup address and instructions", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateVendorPickupSettings")({
      pickupAddress: { streetAddress: "12 Admiralty Way", areaId: "lekki_phase1", areaName: "Lekki Phase 1", stateCode: "LA", stateName: "Lagos", countryCode: "NG", countryName: "Nigeria" },
      pickupInstructions: "Call when you arrive at the gate.",
      pickupContactPhone: "+2348099998888",
    });
    assert(r.data.success);
  });

  await test("Vendor can now enable auto-send with address+instructions saved", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateVendorPickupSettings")({ autoSendPickupDetailsEnabled: true });
    assert(r.data.success);
  });

  await test("Customer CANNOT read vendor pickup settings directly", async () => {
    await signInAs(customerEmail);
    await assertDenied(getDoc(doc(db, "vendors", vendorId, "settings", "pickup")));
  });

  let pickupOrderId, pickupChatId;

  await test("Setup: create a pickup order and get it to accepted state", async () => {
    await signInAs(customerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "pickup", items: [{ itemId: catalogItemId, quantity: 1 }] });
    const orderResult = await httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId });
    pickupOrderId = orderResult.data.orderId;
    pickupChatId = orderResult.data.conversationId;

    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateOrderStatus")({ orderId: pickupOrderId, newStatus: "accepted" });
  });

  await test("Unpaid pickup order does NOT get pickup details sent", async () => {
    const msgsSnap = await admin.firestore().collection("chatThreads").doc(pickupChatId).collection("messages")
      .where("type", "==", "pickup-details").where("orderId", "==", pickupOrderId).get();
    assertEqual(msgsSnap.size, 0, "No pickup-details message before payment");
  });

  await test("Paying (proof accepted) triggers exactly ONE pickup-details message", async () => {
    await signInAs(customerEmail);
    const proofResult = await httpsCallable(fns, "submitPaymentProof")({ orderId: pickupOrderId, images: [{ storagePath: "proof.jpg" }] });
    await signInAs(vendorEmail);
    await httpsCallable(fns, "reviewPaymentProof")({ orderId: pickupOrderId, proofId: proofResult.data.proofId, decision: "accept" });
    await sleep(1000);

    const msgsSnap = await admin.firestore().collection("chatThreads").doc(pickupChatId).collection("messages")
      .where("type", "==", "pickup-details").where("orderId", "==", pickupOrderId).get();
    assertEqual(msgsSnap.size, 1, "Exactly one pickup-details message must be created");

    const msg = msgsSnap.docs[0].data();
    assertEqual(msg.pickupDetailsData.pickupInstructions, "Call when you arrive at the gate.");
    assertEqual(msg.pickupDetailsData.pickupContactPhone, "+2348099998888");
    assert(msg.pickupDetailsData.businessName, "businessName must be included in snapshot");
  });

  await test("Editing vendor pickup settings later does NOT change the old snapshot message", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateVendorPickupSettings")({ pickupInstructions: "NEW instructions — call twice." });

    const msgsSnap = await admin.firestore().collection("chatThreads").doc(pickupChatId).collection("messages")
      .where("type", "==", "pickup-details").where("orderId", "==", pickupOrderId).get();
    assertEqual(msgsSnap.docs[0].data().pickupDetailsData.pickupInstructions, "Call when you arrive at the gate.",
      "Old snapshot must retain the original instructions, not the updated ones");
  });

  await test("Non-pickup order never receives pickup details", async () => {
    await signInAs(customerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "delivery", items: [{ itemId: catalogItemId, quantity: 1 }] });
    const orderResult = await httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId });
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateOrderStatus")({ orderId: orderResult.data.orderId, newStatus: "accepted" });
    await signInAs(customerEmail);
    const proofResult = await httpsCallable(fns, "submitPaymentProof")({ orderId: orderResult.data.orderId, images: [{ storagePath: "proof2.jpg" }] });
    await signInAs(vendorEmail);
    await httpsCallable(fns, "reviewPaymentProof")({ orderId: orderResult.data.orderId, proofId: proofResult.data.proofId, decision: "accept" });
    await sleep(1000);

    const msgsSnap = await admin.firestore().collection("chatThreads").doc(orderResult.data.conversationId).collection("messages")
      .where("type", "==", "pickup-details").where("orderId", "==", orderResult.data.orderId).get();
    assertEqual(msgsSnap.size, 0, "Delivery orders must never receive pickup-details messages");
  });

  await test("No client-callable function exists to manually send pickup details", async () => {
    await signInAs(vendorEmail);
    try {
      await httpsCallable(fns, "sendPickupDetailsNow")({ orderId: pickupOrderId });
      throw new Error("sendPickupDetailsNow should not exist as a callable");
    } catch (e) {
      assert(e.code === "functions/not-found" || e.code === "functions/internal" || e.message.includes("NOT_FOUND"),
        `Expected not-found style error, got: ${e.code} — ${e.message}`);
    }
  });

  await test("Client cannot manually create a pickup-details message via sendChatMessage", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "sendChatMessage")({
        chatId: pickupChatId, type: "pickup-details", content: "fake",
        pickupDetailsData: { businessName: "fake", orderId: pickupOrderId, pickupAddress: {}, pickupInstructions: "fake" },
      }),
      "invalid-argument"
    );
  });
}

async function section9() {
  console.log("\n📋 Section 9: Country availability, delivery contact snapshot, order access expiry");
  let contactOrderId;

  await test("Commerce conversation creation fails when country is disabled", async () => {
    await admin.firestore().collection("countryAvailability").doc("NG").update({ status: "DISABLED" });

    const countryTestEmail = `p3country_${Date.now()}@test.com`;
    const cred = await createUserWithEmailAndPassword(auth, countryTestEmail, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", cred.user.uid)); return s.exists() ? s : null; });
    await signInAs(countryTestEmail);

    await assertFnError(httpsCallable(fns, "createCommerceConversation")({ vendorId }), "failed-precondition");

    // restore
    await admin.firestore().collection("countryAvailability").doc("NG").update({ status: "ACTIVE" });
  });

  await test("Missing countryAvailability document fails safely (fail closed)", async () => {
    await admin.firestore().collection("vendors").doc(vendorId).update({ countryCode: "ZZ" }); // no doc for ZZ

    const missingCountryEmail = `p3missing_${Date.now()}@test.com`;
    const cred = await createUserWithEmailAndPassword(auth, missingCountryEmail, PASSWORD);
    await waitFor(async () => { const s = await getDoc(doc(db, "users", cred.user.uid)); return s.exists() ? s : null; });
    await signInAs(missingCountryEmail);

    await assertFnError(httpsCallable(fns, "createCommerceConversation")({ vendorId }), "failed-precondition");

    await admin.firestore().collection("vendors").doc(vendorId).update({ countryCode: "NG" }); // restore
  });

  await test("Customer can submit a delivery contact snapshot for a specific order", async () => {
    await signInAs(customerEmail);
    const cartResult = await httpsCallable(fns, "repriceCart")({ vendorId, fulfillmentType: "delivery", items: [{ itemId: catalogItemId, quantity: 1 }] });
    const orderResult = await httpsCallable(fns, "createOrderFromCart")({ cartId: cartResult.data.cartId });
    contactOrderId = orderResult.data.orderId;

    const r = await httpsCallable(fns, "submitDeliveryContact")({
      orderId: contactOrderId, fullName: "Jane Customer", phoneNumber: "+2348022223333",
      address: { line1: "5 Marina Rd", area: "Ikoyi", city: "Lagos", state: "Lagos", country: "Nigeria" },
    });
    assert(r.data.success);

    const orderSnap = await admin.firestore().collection("orders").doc(contactOrderId).get();
    assertEqual(orderSnap.data().deliveryContact.fullName, "Jane Customer");
  });

  await test("Delivery contact snapshot cannot be resubmitted for the same order", async () => {
    await signInAs(customerEmail);
    await assertFnError(
      httpsCallable(fns, "submitDeliveryContact")({ orderId: contactOrderId, fullName: "Changed Name", phoneNumber: "+2340000000000" }),
      "already-exists"
    );
  });

  await test("Vendor can view delivery contact via getOrderDetails while order is active", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "getOrderDetails")({ orderId: contactOrderId });
    assert(r.data.order.deliveryContact, "Vendor must see delivery contact while order is active");
    assertEqual(r.data.order.deliveryContact.fullName, "Jane Customer");
  });

  await test("Vendor CANNOT view delivery contact via getOrderDetails after order reaches terminal status", async () => {
    await signInAs(vendorEmail);
    await httpsCallable(fns, "updateOrderStatus")({ orderId: contactOrderId, newStatus: "accepted" });
    await httpsCallable(fns, "updateOrderStatus")({ orderId: contactOrderId, newStatus: "in_progress" });
    await httpsCallable(fns, "updateOrderStatus")({ orderId: contactOrderId, newStatus: "completed" });

    const r = await httpsCallable(fns, "getOrderDetails")({ orderId: contactOrderId });
    assert(!r.data.order.deliveryContact, "Vendor must NOT see delivery contact after order is terminal");
    assertEqual(r.data.order.deliveryContactExpired, true);
  });

  await test("Customer retains access to their own delivery contact after order is terminal", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "getOrderDetails")({ orderId: contactOrderId });
    assert(r.data.order.deliveryContact, "Customer must retain access to their own submitted contact info");
  });

  await test("users/{uid}/contactCards collection does not exist as a persistent library (architectural check)", async () => {
    // Verify no contactCards subcollection is readable/creatable — this
    // documents the local-device-only decision at the rules layer.
    await signInAs(customerEmail);
    await assertDenied(
      setDoc(doc(db, "users", customerUid, "contactCards", "someCard"), { fullName: "test", phoneNumber: "123" })
    );
  });
}

async function section10() {
  console.log("\n📋 Section 10: Support tickets (P3-FB-015) and AI help placeholder (P3-FB-016)");
  let ticket1Id, ticket2Id;

  await test("Customer can create a support ticket", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createSupportTicket")({
      subject: "Payment not going through",
      initialMessage: "My proof of payment keeps getting rejected.",
    });
    assert(r.data.success);
    assert(r.data.created, "First call must create a new ticket");
    ticket1Id = r.data.ticketId;
    assertEqual(r.data.chatId, ticket1Id);

    const threadSnap = await getDoc(doc(db, "chatThreads", ticket1Id));
    assertEqual(threadSnap.data().chatType, "support");
    assert(threadSnap.data().participants.includes(customerUid));

    const ticketSnap = await getDoc(doc(db, "supportTickets", ticket1Id));
    assertEqual(ticketSnap.data().status, "open");
    assertEqual(ticketSnap.data().priority, "normal");
    assertEqual(ticketSnap.data().requesterUid, customerUid);

    const msgs = await getDocs(collection(db, "chatThreads", ticket1Id, "messages"));
    assertEqual(msgs.size, 1);
    assertEqual(msgs.docs[0].data().content, "My proof of payment keeps getting rejected.");
  });

  await test("Creating a second ticket while one is open returns the existing ticket, not a duplicate", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createSupportTicket")({
      subject: "Different subject",
      initialMessage: "A different message.",
    });
    assertEqual(r.data.created, false);
    assertEqual(r.data.ticketId, ticket1Id);
  });

  await test("subject and initialMessage are required", async () => {
    await signInAs(customerEmail);
    await assertFnError(
      httpsCallable(fns, "createSupportTicket")({ subject: "", initialMessage: "hi" }),
      "invalid-argument"
    );
    await assertFnError(
      httpsCallable(fns, "createSupportTicket")({ subject: "Subject", initialMessage: "" }),
      "invalid-argument"
    );
  });

  await test("A different customer cannot read another user's support ticket or thread", async () => {
    await signInAs(secondCustomerEmail);
    await assertDenied(getDoc(doc(db, "supportTickets", ticket1Id)));
    await assertDenied(getDoc(doc(db, "chatThreads", ticket1Id)));
  });

  await test("supportTickets cannot be written directly by clients", async () => {
    await signInAs(customerEmail);
    await assertDenied(
      setDoc(doc(db, "supportTickets", ticket1Id), { status: "resolved" }, { merge: true })
    );
  });

  await test("Admin can assign a support ticket, joining the thread and setting priority", async () => {
    await signInAs(adminEmail);
    const r = await httpsCallable(fns, "assignSupportTicket")({ ticketId: ticket1Id, priority: "high" });
    assert(r.data.success);

    const ticketSnap = await getDoc(doc(db, "supportTickets", ticket1Id));
    assertEqual(ticketSnap.data().status, "assigned");
    assertEqual(ticketSnap.data().priority, "high");
    assertEqual(ticketSnap.data().assignedAdminUid, adminUid);

    const threadSnap = await getDoc(doc(db, "chatThreads", ticket1Id));
    assert(threadSnap.data().participants.includes(adminUid), "Admin must be added as a thread participant");
    assertEqual(threadSnap.data().participantRoles[adminUid], "admin");
  });

  await test("Assigning an invalid priority is rejected", async () => {
    await signInAs(adminEmail);
    await assertFnError(
      httpsCallable(fns, "assignSupportTicket")({ ticketId: ticket1Id, priority: "extreme" }),
      "invalid-argument"
    );
  });

  await test("Non-admin cannot assign a support ticket", async () => {
    await signInAs(customerEmail);
    await assertFnError(
      httpsCallable(fns, "assignSupportTicket")({ ticketId: ticket1Id }),
      "permission-denied"
    );
  });

  await test("A limited support_admin who is not the assigned agent (and not super_admin) cannot resolve the ticket", async () => {
    const limitedEmail = `p3supportadmin_${Date.now()}@the platform.com`;
    const limitedCred = await createUserWithEmailAndPassword(auth, limitedEmail, PASSWORD);
    const limitedUid = limitedCred.user.uid;
    await waitFor(async () => { const s = await getDoc(doc(db, "users", limitedUid)); return s.exists() ? s : null; });
    await admin.auth().setCustomUserClaims(limitedUid, { role: "admin", adminRoleIds: ["support_admin"], claimsVersion: 1 });
    await admin.firestore().collection("adminUsers").doc(limitedUid).set({
      uid: limitedUid, email: limitedEmail, roleIds: ["support_admin"], status: "active",
      mfaRequired: true, mfaEnrolled: false, createdByAdminUid: adminUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: null, revokedAt: null, lastMfaAt: null,
    });

    await signInAs(limitedEmail);
    await assertFnError(
      httpsCallable(fns, "resolveSupportTicket")({ ticketId: ticket1Id }),
      "permission-denied"
    );
  });

  await test("The assigned admin can resolve the ticket", async () => {
    await signInAs(adminEmail);
    const r = await httpsCallable(fns, "resolveSupportTicket")({ ticketId: ticket1Id });
    assert(r.data.success);

    const ticketSnap = await getDoc(doc(db, "supportTickets", ticket1Id));
    assertEqual(ticketSnap.data().status, "resolved");
    assertEqual(ticketSnap.data().resolvedByAdminUid, adminUid);
  });

  await test("Assigning an already-resolved ticket fails", async () => {
    await signInAs(adminEmail);
    await assertFnError(
      httpsCallable(fns, "assignSupportTicket")({ ticketId: ticket1Id }),
      "failed-precondition"
    );
  });

  await test("Customer can open a new ticket once the previous one is resolved", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createSupportTicket")({
      subject: "Second issue",
      initialMessage: "Now a different problem.",
    });
    assert(r.data.created, "A new ticket must be created once the prior one is resolved");
    ticket2Id = r.data.ticketId;
    assert(ticket2Id !== ticket1Id);
  });

  await test("Resolving a ticket that is not in 'assigned' status fails", async () => {
    await signInAs(adminEmail);
    await assertFnError(
      httpsCallable(fns, "resolveSupportTicket")({ ticketId: ticket2Id }),
      "failed-precondition"
    );
  });

  await test("createAiHelpThread creates a deterministic per-user thread with a canned response", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createAiHelpThread")({});
    assert(r.data.success);
    assert(r.data.created, "First call must create the thread");
    assertEqual(r.data.chatId, `ai_help_${customerUid}`);

    const threadSnap = await getDoc(doc(db, "chatThreads", r.data.chatId));
    assertEqual(threadSnap.data().chatType, "ai_help");
    assertEqual(threadSnap.data().lastMessageType, "ai");

    const msgs = await getDocs(collection(db, "chatThreads", r.data.chatId, "messages"));
    assertEqual(msgs.size, 1);
    assertEqual(msgs.docs[0].data().senderRole, "ai");
    assertEqual(msgs.docs[0].data().type, "ai");
  });

  await test("createAiHelpThread is idempotent — no duplicate thread or message on repeat calls", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createAiHelpThread")({});
    assertEqual(r.data.created, false);
    assertEqual(r.data.chatId, `ai_help_${customerUid}`);

    const msgs = await getDocs(collection(db, "chatThreads", r.data.chatId, "messages"));
    assertEqual(msgs.size, 1, "Repeat calls must not create a second canned message");
  });
}

async function section11() {
  console.log("\n📋 Section 11: Chat moderation — rule-based flagging system (P3-FB-021)");
  let modChatId, modThreadRef;

  await test("Non-super_admin cannot seed moderation rules", async () => {
    await signInAs(customerEmail);
    await assertFnError(httpsCallable(fns, "seedDefaultModerationRules")({}), "permission-denied");
  });

  await test("super_admin can seed default moderation rules, idempotently", async () => {
    await signInAs(adminEmail);
    const r1 = await httpsCallable(fns, "seedDefaultModerationRules")({});
    assert(r1.data.success);
    assert(r1.data.ruleCount > 30, "Expected a substantial default rule set");
    const r2 = await httpsCallable(fns, "seedDefaultModerationRules")({});
    assertEqual(r2.data.ruleCount, r1.data.ruleCount, "Re-seeding must upsert, not duplicate");
  });

  await test("Setup: fresh commerce thread for moderation tests", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    modChatId = r.data.chatId;
    modThreadRef = doc(db, "chatThreads", modChatId);
  });

  await test("A normal commerce message is clean — not flagged, not blocked", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId: modChatId, type: "text", content: "Hi, do you have this in blue?" });
    assert(r.data.success);
    const msgSnap = await getDoc(doc(db, "chatThreads", modChatId, "messages", r.data.messageId));
    assertEqual(msgSnap.data().moderationStatus, "clean");
    assertEqual(msgSnap.data().moderationScore, 0);
  });

  await test("A neutral payment term ALONE (no off-platform phrase) is never flagged", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId: modChatId, type: "text", content: "Please share your bank transfer details" });
    const msgSnap = await getDoc(doc(db, "chatThreads", modChatId, "messages", r.data.messageId));
    assertEqual(msgSnap.data().moderationStatus, "clean", "bank transfer alone must not be flagged");
  });

  await test("Low-severity Nigerian-slang term is flagged but still sent (allow_flag)", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId: modChatId, type: "text", content: "mumu, why is this so expensive" });
    assert(r.data.success, "Low severity must not block the send");
    const msgSnap = await getDoc(doc(db, "chatThreads", modChatId, "messages", r.data.messageId));
    assertEqual(msgSnap.data().moderationStatus, "flagged");
    assert(msgSnap.data().moderationScore > 0);
  });

  await test("Medium-severity standalone phrase combined with a neutral term escalates to needs_review, still sent", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId: modChatId, type: "text", content: "ignore the app, call me instead" });
    assert(r.data.success, "hold_for_review must not block the send");
    const msgSnap = await getDoc(doc(db, "chatThreads", modChatId, "messages", r.data.messageId));
    assertEqual(msgSnap.data().moderationStatus, "needs_review");
  });

  await test("High-severity off-platform phrase BLOCKS the message entirely", async () => {
    await signInAs(customerEmail);
    const before = await getDocs(collection(db, "chatThreads", modChatId, "messages"));
    await assertFnError(
      httpsCallable(fns, "sendChatMessage")({ chatId: modChatId, type: "text", content: "let's pay outside the platform" }),
      "invalid-argument"
    );
    const after = await getDocs(collection(db, "chatThreads", modChatId, "messages"));
    assertEqual(after.size, before.size, "A blocked message must never be persisted");
  });

  // Critical-severity content scores +100 against the account (matching the
  // "100 points -> automatic suspension" spec), which immediately crosses
  // the ban threshold in a single message. That escalation is account-wide,
  // not message-wide, so it must NOT happen on customerEmail (reused by
  // every other test in this section) — a dedicated throwaway account
  // carries the rest of this narrative: one critical block, immediate
  // account-wide lockout, then an explicit admin review path back.
  let criticalEmail, criticalUid, criticalChatId;

  await test("Critical-severity content (weapons) BLOCKS the message", async () => {
    criticalEmail = `p3modcrit_${Date.now()}@test.com`;
    const cred = await createUserWithEmailAndPassword(auth, criticalEmail, PASSWORD);
    criticalUid = cred.user.uid;
    await waitFor(async () => { const s = await getDoc(doc(db, "users", criticalUid)); return s.exists() ? s : null; });
    await signInAs(criticalEmail);
    // Create the thread BEFORE the ban lands — createCommerceConversation
    // itself checks accountStatus === "active" ahead of its idempotent
    // thread lookup, so it could never be called again once this account
    // is banned. Every later step in this test reuses this same chatId.
    const convo = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    criticalChatId = convo.data.chatId;
    await assertFnError(
      httpsCallable(fns, "sendChatMessage")({ chatId: criticalChatId, type: "text", content: "I want to buy a gun" }),
      "invalid-argument"
    );
  });

  await test("A single critical match immediately bans the account (cumulative score >= 100)", async () => {
    const userSnap = await admin.firestore().collection("users").doc(criticalUid).get();
    assertEqual(userSnap.data().accountStatus, "banned");
    assert(userSnap.data().moderationScore >= 100);
  });

  await test("Once banned, ANY further message — even clean content — is rejected account-wide", async () => {
    await signInAs(criticalEmail);
    await assertFnError(
      httpsCallable(fns, "sendChatMessage")({ chatId: criticalChatId, type: "text", content: "hello, just saying hi" }),
      "permission-denied"
    );
  });

  await test("Non-admin cannot review/clear a moderation restriction", async () => {
    await signInAs(customerEmail);
    await assertFnError(
      httpsCallable(fns, "reviewModerationRestriction")({ uid: criticalUid, decision: "clear" }),
      "permission-denied"
    );
  });

  await test("Admin can clear a moderation restriction after review, restoring access", async () => {
    await signInAs(adminEmail);
    const r = await httpsCallable(fns, "reviewModerationRestriction")({ uid: criticalUid, decision: "clear" });
    assert(r.data.success);

    const userSnap = await admin.firestore().collection("users").doc(criticalUid).get();
    assertEqual(userSnap.data().accountStatus, "active");
    assertEqual(userSnap.data().moderationScore, 0);

    await signInAs(criticalEmail);
    const sendResult = await httpsCallable(fns, "sendChatMessage")({ chatId: criticalChatId, type: "text", content: "hello again" });
    assert(sendResult.data.success, "Cleared account must be able to send again");
  });

  await test("Client cannot set moderationStatus manually — server-computed value always wins", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({
      chatId: modChatId, type: "text", content: "Just a normal question about delivery",
      moderationStatus: "blocked", moderationScore: 999,
    });
    const msgSnap = await getDoc(doc(db, "chatThreads", modChatId, "messages", r.data.messageId));
    assertEqual(msgSnap.data().moderationStatus, "clean", "Client-supplied moderationStatus must be ignored");
    assertEqual(msgSnap.data().moderationScore, 0);
  });

  await test("Thread riskScore accumulates across flagged messages", async () => {
    const threadSnap = await getDoc(modThreadRef);
    assert(threadSnap.data().riskScore > 0, "riskScore must have accumulated from the flagged/needs_review messages above");
  });

  await test("moderationEvents is not client-readable by the customer who triggered it", async () => {
    await signInAs(customerEmail);
    await assertDenied(getDocs(collection(db, "moderationEvents")));
  });

  await test("moderationEvents is not client-writable by anyone", async () => {
    await signInAs(customerEmail);
    await assertDenied(setDoc(doc(db, "moderationEvents", "fake"), { category: "weapons" }));
  });

  await test("Admin CAN read moderationEvents for review", async () => {
    await signInAs(adminEmail);
    const snap = await getDocs(collection(db, "moderationEvents"));
    assert(snap.size > 0, "Expected moderation events from the blocked/flagged messages above");
  });

  await test("moderationRules is not client-readable or writable by non-admins", async () => {
    await signInAs(customerEmail);
    await assertDenied(getDocs(collection(db, "moderationRules")));
    await assertDenied(setDoc(doc(db, "moderationRules", "fake"), { category: "weapons" }));
  });

  await test("Vendor greeting/away messages are validated — unsafe text is rejected", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "updateVendorChatSettings")({ awayMessageEnabled: true, awayMessage: "I want to buy a gun" }),
      "invalid-argument"
    );
  });

  await test("Vendor greeting/away messages with normal text are accepted", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "updateVendorChatSettings")({ awayMessageEnabled: true, awayMessage: "We are currently closed, back soon!" });
    assert(r.data.success);
  });

  await test("Vendor quick reply with unsafe content is rejected", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "createQuickReply")({ title: "Bad", shortcut: "/bad", message: "cocaine for sale here" }),
      "invalid-argument"
    );
  });

  await test("Vendor quick reply with normal content is accepted", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createQuickReply")({ title: "Thanks", shortcut: "/thanks", message: "Thank you for your order!" });
    assert(r.data.success);
  });
}

async function section12() {
  console.log("\n📋 Section 12: Catalog moderation, PII detection, and expanded critical categories (P3-FB-021)");
  let section12ChatId;

  await test("Setup: reuse the customer/vendor commerce thread", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "createCommerceConversation")({ vendorId });
    section12ChatId = r.data.chatId; // idempotent — same thread as Section 11's modChatId
  });

  await test("Catalog listing for a prohibited item is blocked outright", async () => {
    await signInAs(vendorEmail);
    await assertFnError(
      httpsCallable(fns, "createCatalogItem")({ name: "Pistol for sale, cheap", basePrice: 5000, currency: "NGN", isAvailable: true }),
      "invalid-argument"
    );
  });

  await test("Catalog listing with normal content is accepted", async () => {
    await signInAs(vendorEmail);
    const r = await httpsCallable(fns, "createCatalogItem")({ name: "Second Safe Item", basePrice: 800, currency: "NGN", isAvailable: true });
    assert(r.data.success);
  });

  await test("updateCatalogItem also rejects a prohibited-item rename", async () => {
    await signInAs(vendorEmail);
    const created = await httpsCallable(fns, "createCatalogItem")({ name: "Placeholder Name", basePrice: 100, currency: "NGN", isAvailable: true });
    await assertFnError(
      httpsCallable(fns, "updateCatalogItem")({ itemId: created.data.itemId, name: "Raw chicken, farm fresh" }),
      "invalid-argument"
    );
  });

  await test("A shared phone number is flagged (never blocked), and contributes to moderation score", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId: section12ChatId, type: "text", content: "You can reach me at +2348012345678" });
    assert(r.data.success, "A phone number alone must never block a message");
    const msgSnap = await getDoc(doc(db, "chatThreads", section12ChatId, "messages", r.data.messageId));
    assertEqual(msgSnap.data().moderationStatus, "flagged");
    assert(msgSnap.data().moderationScore > 0);
  });

  await test("A WhatsApp link is flagged (never blocked)", async () => {
    await signInAs(customerEmail);
    const r = await httpsCallable(fns, "sendChatMessage")({ chatId: section12ChatId, type: "text", content: "here is my number wa.me/2348012345678" });
    assert(r.data.success, "A WhatsApp link alone must never block a message");
    const msgSnap = await getDoc(doc(db, "chatThreads", section12ChatId, "messages", r.data.messageId));
    assertEqual(msgSnap.data().moderationStatus, "flagged");
  });

  await test("Terrorism-related content BLOCKS the message", async () => {
    await signInAs(customerEmail);
    await assertFnError(
      httpsCallable(fns, "sendChatMessage")({ chatId: section12ChatId, type: "text", content: "ask me about isis" }),
      "invalid-argument"
    );
  });
}

async function main() {
  console.log("🚀 THE PLATFORM — Milestone 3 Acceptance Test Suite");
  console.log("=".repeat(60));

  await setup();
  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();
  await section7();
  await section8();
  await section9();
  await section10();
  await section11();
  await section12();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed === 0) console.log("✅ ALL TESTS PASSED — Milestone 3 ready for sign-off");
  else { console.log("❌ SOME TESTS FAILED — see errors above"); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}
main().catch(err => { console.error("Fatal:", err); process.exit(1); });
