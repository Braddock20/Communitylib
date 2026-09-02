import { PDFDocument } from 'pdf-lib';

export async function imagesToPdf(images) {
  const pdfDoc = await PDFDocument.create();

  for (const img of images) {
    const ext = (img.ext || '').toLowerCase();
    let embedded;
    if (ext === 'png') {
      embedded = await pdfDoc.embedPng(img.bytes);
    } else if (ext === 'jpg' || ext === 'jpeg') {
      embedded = await pdfDoc.embedJpg(img.bytes);
    } else {
      throw new Error(`Unsupported image format for PDF conversion: ${ext || 'unknown'}`);
    }

    const { width, height } = embedded;
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  }

  if (pdfDoc.getPageCount() === 0) throw new Error('No convertible images were supplied');
  return pdfDoc.save();
}

export function isImageExt(ext) {
  return ['jpg', 'jpeg', 'png', 'webp'].includes((ext || '').toLowerCase());
}

export function isPdfExt(ext) {
  return (ext || '').toLowerCase() === 'pdf';
}

export function isPdfConvertibleImageExt(ext) {
  // webp deliberately excluded — pdf-lib can only embed PNG/JPEG. A webp
  // file stays as a standalone image resource instead of joining the
  // combined PDF (see upload.js).
  return ['jpg', 'jpeg', 'png'].includes((ext || '').toLowerCase());
}
