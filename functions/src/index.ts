// ── Phase 1: Auth ────────────────────────────────────────────────────────────
export { onUserCreate } from "./auth/onUserCreate";
export { onUserDelete } from "./auth/onUserDelete";
export { completeRegistration, getClaimsVersion } from "./auth/completeRegistration";
export { checkUsernameAvailability, changeUsername } from "./auth/usernameReservation";
export { sendEmailOtp, verifyEmailOtp } from "./auth/emailOtp";
export { sendPhoneOtp, verifyPhoneOtp } from "./auth/phoneOtp";

// ── Phase 1: Vendors ─────────────────────────────────────────────────────────
export { onVendorWrite } from "./vendors/onVendorWrite";
export { onVendorVerificationDocumentWrite } from "./vendors/verificationSubmission";
export { setVendorPublishStatus } from "./vendors/setVendorPublishStatus";
export { recordVerificationDocument, submitVendorVerification } from "./vendors/verificationSubmission";

// ── Phase 1: Admin ───────────────────────────────────────────────────────────
export { approveVendorVerification, rejectVendorVerification, requestVerificationRetry,
         suspendVendor, deactivateVendor, reactivateVendor } from "./admin/vendorModeration";
export { createAdminInvite, acceptAdminInvite, revokeAdminAccess,
         recordAdminSession } from "./admin/adminInvites";

// ── Phase 2: Catalog ─────────────────────────────────────────────────────────
export { createCatalogItem, updateCatalogItem, deleteCatalogItem,
         onCatalogItemWrite, createCatalogCategory } from "./catalog/catalogFunctions";

// ── Phase 2: Cart ─────────────────────────────────────────────────────────────
export { repriceCart } from "./orders/repriceCart";

// ── Phase 2: Orders ───────────────────────────────────────────────────────────
export { createOrderFromCart, createExternalOrder } from "./orders/createOrder";
export { updateOrderStatus, handleChangeRequest } from "./orders/updateOrderStatus";
export { submitPaymentProof, reviewPaymentProof } from "./orders/paymentProofs";

// ── Phase 2: Receipts ─────────────────────────────────────────────────────────
export { getReceipt } from "./receipts/receiptFunctions";

// ── Phase 3: Order-scoped contact + safe order reads ──────────────────────────
export { submitDeliveryContact } from "./orders/submitDeliveryContact";
export { getOrderDetails } from "./orders/getOrderDetails";

// ── Phase 3: Chat ─────────────────────────────────────────────────────────────
export { createCommerceConversation } from "./chat/createCommerceConversation";
export { sendChatMessage } from "./chat/sendChatMessage";
export { markChatRead, saveChatDraft, clearChatDraft } from "./chat/chatReadAndDrafts";
export { updateVendorChatSettings } from "./chat/awayMessage";
export { updateVendorPickupSettings } from "./chat/pickupSettings";
export { createQuickReply, updateQuickReply, deleteQuickReply } from "./chat/quickReplies";

// ── Phase 3: Blocks ───────────────────────────────────────────────────────────
export { blockUser, unblockUser } from "./blocks/blockFunctions";

// ── Phase 3: Notifications ────────────────────────────────────────────────────
export { markNotificationRead, registerPushToken } from "./notifications/notificationFunctions";
export { updateVendorNotificationPreferences,
         updateCustomerNotificationPreferences } from "./notifications/notificationPreferences";

// ── Phase 3: Support tickets ──────────────────────────────────────────────────
export { createSupportTicket, assignSupportTicket, resolveSupportTicket } from "./support/supportTicketFunctions";

// ── Phase 3: AI help placeholder ──────────────────────────────────────────────
export { createAiHelpThread } from "./ai/aiHelpFunctions";

// ── Phase 3: Moderation ────────────────────────────────────────────────────────
export { seedDefaultModerationRules, reviewModerationRestriction } from "./moderation/moderationAdmin";
