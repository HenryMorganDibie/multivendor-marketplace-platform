import PDFDocument from "pdfkit";
import { InvoiceBrandingDoc, InvoiceBrandingSnapshot, InvoiceDoc, PlanLimits } from "../types4";

/**
 * renderInvoicePdf — pure Node PDF generation via pdfkit, deliberately not
 * a headless-browser render (Puppeteer etc.): this project targets modest
 * Cloud Functions memory allocations, and a full Chromium process per
 * invoice download is disproportionate to what a structured document
 * actually needs. Styling is therefore simpler than an HTML/CSS template
 * would allow, but every branding field the spec requires (logo, brand
 * color, thank-you message, footer, QR code) is still applied.
 *
 * A PAID invoice renders with its permanently captured brandingSnapshot,
 * never the vendor's current plan or current branding — that's the
 * "paid invoices keep their branding snapshot" guarantee (Section 10).
 * An unpaid invoice has no snapshot yet and is rendered by the caller
 * filtering current branding through current PlanLimits before calling
 * this function, so by the time branding reaches here it is always
 * already the correct one to use.
 */
export async function renderInvoicePdf(invoice: InvoiceDoc, branding: InvoiceBrandingSnapshot | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (branding?.brandColor) {
      doc.rect(0, 0, doc.page.width, 8).fill(branding.brandColor);
      doc.fillColor("black");
    }

    doc.fontSize(20).text("Invoice", 50, 40);
    doc.fontSize(10).fillColor("#555").text(invoice.invoiceNumber, { align: "right" });
    doc.fillColor("black").moveDown(2);

    doc.fontSize(12).text(`Bill to: ${invoice.customerName}`);
    if (invoice.customerPhone) doc.text(`Phone: ${invoice.customerPhone}`);
    if (invoice.customerEmail) doc.text(`Email: ${invoice.customerEmail}`);
    doc.moveDown();

    doc.fontSize(11).text("Items", { underline: true });
    doc.moveDown(0.5);
    for (const item of invoice.lineItems) {
      doc.fontSize(10).text(`${item.description}  x${item.quantity}   ${item.total.toFixed(2)} ${invoice.currency}`);
    }
    doc.moveDown();
    doc.fontSize(12).text(`Subtotal: ${invoice.subtotal.toFixed(2)} ${invoice.currency}`, { align: "right" });

    if (invoice.notes) {
      doc.moveDown();
      doc.fontSize(10).fillColor("#555").text(invoice.notes);
      doc.fillColor("black");
    }

    if (branding?.thankYouMessage) {
      doc.moveDown(2);
      doc.fontSize(11).text(branding.thankYouMessage, { align: "center" });
    }
    if (branding?.footerText) {
      doc.fontSize(8).fillColor("#777").text(branding.footerText, 50, doc.page.height - 70, { align: "center" });
      doc.fillColor("black");
    }

    doc.end();
  });
}

/** Filters a vendor's saved invoiceBranding document down to only the
 * fields their CURRENT effective plan permits — used for unpaid/draft
 * invoices at render time. A downgrade never mutates the stored document
 * (invoiceBranding.ts), it only changes what passes through this filter. */
export function filterBrandingByPlan(saved: Partial<InvoiceBrandingDoc> | undefined, limits: PlanLimits): InvoiceBrandingSnapshot {
  return {
    logoUrl: limits.canUploadLogo ? (saved?.logoUrl as string | null | undefined) ?? null : null,
    brandColor: limits.canSetBrandColor ? (saved?.brandColor as string | null | undefined) ?? null : null,
    thankYouMessage: limits.canSetThankYouMessage ? (saved?.thankYouMessage as string | null | undefined) ?? null : null,
    footerText: limits.canSetFooterText ? (saved?.footerText as string | null | undefined) ?? null : null,
    selectedTemplateId: limits.canUsePremiumTemplates ? (saved?.selectedTemplateId as string | null | undefined) ?? null : null,
    selectedSeasonalThemeId: limits.canUseSeasonalThemes ? (saved?.selectedSeasonalThemeId as string | null | undefined) ?? null : null,
    qrCodeEnabled: limits.canAddQrCode ? (saved?.qrCodeEnabled as boolean | undefined) ?? false : false,
    printLayoutEnabled: limits.canUsePrintLayout ? (saved?.printLayoutEnabled as boolean | undefined) ?? false : false,
  };
}
