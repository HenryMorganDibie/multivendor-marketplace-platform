// ── Phase 1: Auth ────────────────────────────────────────────────────────────
export { onUserCreate } from "./auth/onUserCreate";
export { cleanupOrphanedAccounts, cleanupOrphanedAccount } from "./auth/orphanAccountCleanup";
export { onUserDelete } from "./auth/onUserDelete";
export { completeRegistration, getClaimsVersion, repairVendorClaims } from "./auth/completeRegistration";
export { checkUsernameAvailability, changeUsername } from "./auth/usernameReservation";
export { sendEmailOtp, verifyEmailOtp } from "./auth/emailOtp";
export { sendPhoneOtp, verifyPhoneOtp } from "./auth/phoneOtp";
export { requestAccountDeletion, restoreAccountIfEligible } from "./auth/accountDeletion";
export { signOutAllDevices } from "./auth/sessionManagement";

// ── Phase 1: Vendors ─────────────────────────────────────────────────────────
export { onVendorWrite } from "./vendors/onVendorWrite";
export { recordPayment } from "./payments/paymentLedger";
export { reversePayment } from "./payments/reversePayment";
export { listPayments, getVendorRevenue } from "./payments/readLedger";
export { onCountryAvailabilityWrite } from "./vendors/onCountryAvailabilityWrite";
export { onVendorVerificationDocumentWrite } from "./vendors/verificationSubmission";
export { setVendorPublishStatus } from "./vendors/setVendorPublishStatus";
export { getVendorOnboardingStatus } from "./vendors/onboardingStatus";
export { getDashboardInsights } from "./vendors/dashboardInsights";
export { recordVerificationDocument, submitVendorVerification } from "./vendors/verificationSubmission";

// ── Phase 1: Admin ───────────────────────────────────────────────────────────
export { approveVendorVerification, rejectVendorVerification, requestVerificationRetry,
         suspendVendor, deactivateVendor, reactivateVendor } from "./admin/vendorModeration";
export { approveCatalogItem, rejectCatalogItem, listCatalogModerationQueue } from "./admin/catalogModeration";
export { createAdminInvite, acceptAdminInvite, revokeAdminAccess,
         recordAdminSession } from "./admin/adminInvites";
export { beginAdminMfaEnrollment, confirmAdminMfaEnrollment,
         verifyAdminMfaCode } from "./admin/adminMfa";

// ── Phase 2: Catalog ─────────────────────────────────────────────────────────
export { createCatalogItem, updateCatalogItem, deleteCatalogItem,
         getCatalogItemModeration,
         onCatalogItemWrite, createCatalogCategory, updateCatalogCategory, deleteCatalogCategory } from "./catalog/catalogFunctions";

// ── Promotions ────────────────────────────────────────────────────────────────
export { createPromotion, updatePromotion, deletePromotion,
         togglePromotionActive, listVendorPromotions } from "./catalog/promotionFunctions";

// ── Phase 2: Cart ─────────────────────────────────────────────────────────────
export { repriceCart } from "./orders/repriceCart";

// ── Phase 2: Orders ───────────────────────────────────────────────────────────
export { createOrderFromCart, createExternalOrder } from "./orders/createOrder";
export { updateOrderStatus, handleChangeRequest } from "./orders/updateOrderStatus";
export { submitPaymentProof, reviewPaymentProof } from "./orders/paymentProofs";
export { sendPaymentRequestInChat } from "./orders/sendPaymentRequestInChat";
export { expireStaleOrders } from "./orders/expireStaleOrders";
export { scanUploadedFile } from "./storage/scanUploadedFile";
// Pixel-dimension enforcement + resize/compression for CMS uploads
// (LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md Section 2.4), a separate
// Storage trigger from scanUploadedFile above; see the file for why.
export { processSiteContentImage } from "./storage/processSiteContentImage";

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

// ── Phase 4: Vendor subscriptions ───────────────────────────────────────────────
export { seedSubscriptionPlans, cancelSubscriptionAdmin, applyManualSubscriptionOverride } from "./subscriptions/subscriptionAdmin";
export { handlePaystackWebhook } from "./subscriptions/paystackWebhook";
export { handleFlutterwaveWebhook } from "./subscriptions/flutterwaveWebhook";
export { handleStripeWebhook } from "./subscriptions/stripeWebhook";
// SCAFFOLD (see appleWebhook.ts header): not exercisable end-to-end until
// APPLE_IAP_KEY_ID/APPLE_IAP_ISSUER_ID are real, the subscription products
// exist in App Store Connect, and the sandbox/production notification URLs
// are registered with Apple pointing at this function.
export { handleAppleWebhook } from "./subscriptions/appleWebhook";
export { getOrCreateAppleAppAccountToken } from "./subscriptions/appleAppAccountToken";
export { verifyAppleTransaction } from "./subscriptions/verifyAppleTransaction";
export { handleGoogleWebhook } from "./subscriptions/googleWebhook";
export { verifyGoogleTransaction } from "./subscriptions/verifyGoogleTransaction";
export { createSubscriptionCheckout, getVendorSubscriptionOfferings, getPublicSubscriptionOfferings, getSubscriptionStatus, cancelSubscription, reactivateSubscription, requestSubscriptionDowngrade, cancelPendingDowngrade } from "./subscriptions/subscriptionFunctions";
export { generateVendorPortalHandoffUrl } from "./subscriptions/vendorPortalHandoff";
// createFlutterwaveCheckout / createStripeCheckout are no longer exported —
// they became internal-only functions (runFlutterwaveCheckout /
// runStripeCheckout) called exclusively by createSubscriptionCheckout, per
// the provider-neutral checkout correction (frontend-subscription-
// alignment-scope.md Section 4 / LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md
// Section 4). Confirmed safe: no client ever called these two directly.
// getCheckoutAvailability is superseded by getVendorSubscriptionOfferings /
// getPublicSubscriptionOfferings, which also return pricing — not just a
// boolean — and is no longer exported.
export { expireStaleSubscriptions, gracePeriodReminder } from "./subscriptions/scheduledJobs";
export { updateVendorSettings } from "./vendors/updateVendorSettings";
export { updateVendorPaymentInstructions } from "./vendors/updateVendorPaymentInstructions";
export { setVendorPaymentInstructions } from "./vendors/setVendorPaymentInstructions";
export { updateVendorBusinessDetails } from "./vendors/updateVendorBusinessDetails";
export { updateVendorLocation } from "./vendors/updateVendorLocation";
export { updateVendorStorefront } from "./vendors/updateVendorStorefront";
export { getVendorDashboard, getBusinessAnalytics } from "./vendors/dashboardAnalytics";
export { getVendorPortalAccess } from "./vendors/portalAccess";

// ── Phase 4: Ratings ────────────────────────────────────────────────────────────
export { submitRating, getVendorRatings, moderateRating } from "./ratings/ratingFunctions";
export { onRatingWrite } from "./ratings/onRatingWrite";

// ── Phase 4: Invoices ────────────────────────────────────────────────────────────
export { createInvoice, listInvoices, downloadInvoicePdf, duplicateInvoice,
         updateInvoiceStatus, getPublicInvoice } from "./invoices/invoiceFunctions";
export { deleteInvoice } from "./invoices/deleteInvoice";
export { updateInvoice } from "./invoices/updateInvoice";
export { sendInvoiceInChat } from "./invoices/sendInvoiceInChat";
export { updateInvoiceBranding } from "./invoices/invoiceBranding";
export { cleanupExpiredInvoiceVisibility } from "./invoices/cleanupExpiredInvoiceVisibility";
export { getVendorBillingHistory } from "./subscriptions/billingHistoryFunctions";

// ── Landing Page / CMS / Vendor Portal (LANDING_PAGE_CMS_VENDOR_PORTAL_MAPPING.md) ─
export { getPublicSiteContent, getSiteContentDraft, saveSiteContentDraft, publishSiteContent } from "./site/siteContentFunctions";
export { submitContactForm, joinWaitlist } from "./site/contactFormFunctions";

// Location catalogue reads. The data has been in Firestore since the importer
// ran; these are the first functions that read it.
export { listCountries, listStates, listAreas, validateLocationSelection } from "./locations/locationFunctions";
