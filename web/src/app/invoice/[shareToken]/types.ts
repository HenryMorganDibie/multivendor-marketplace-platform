import { InvoiceLineItem, InvoiceStatus } from "@/lib/types";

export interface InvoiceDocShape {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  customerEmail?: string | null;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  currency: string;
  status: InvoiceStatus;
  notes?: string | null;
}

export type InvoiceDoc = InvoiceDocShape;
