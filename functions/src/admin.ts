import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

if (admin.apps.length === 0) {
  admin.initializeApp();
}

export const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
export const auth = admin.auth();
export const messaging = admin.messaging();
export { admin, FieldValue, Timestamp };
