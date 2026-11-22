import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

const TOTAL_PAGES = 12;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BODY_SIZE = 11;
const BODY_LINE_HEIGHT = 19;
const FOOTER_TEXT = 'Dokumen fiktif — bukan peraturan nyata.';

type FixturePage = {
  heading: string;
  subheading?: string;
  body: string[];
  cover?: boolean;
};

const PAGES: FixturePage[] = [
  {
    cover: true,
    heading: 'Peraturan Perusahaan',
    subheading: 'PT Contoh Sejahtera',
    body: [
      '(Dokumen Fiktif untuk Pengujian)',
      'PT Contoh Sejahtera adalah perusahaan fiktif. Seluruh nama, kebijakan, dan angka dalam dokumen ini dibuat hanya untuk pengujian perangkat lunak dan tidak merujuk pada perusahaan, orang, atau alamat nyata.',
      `Dokumen ini terdiri dari ${TOTAL_PAGES} halaman dan berlaku sejak 1 Januari 2026.`,
    ],
  },
  {
    heading: 'Pasal 1 — Jam Kerja',
    body: [
      '1. Hari kerja kantor adalah Senin sampai Jumat.',
      '2. Jam kerja kantor adalah 08.00–17.00.',
      '3. Istirahat siang berlangsung pukul 12.00 sampai 13.00.',
      '4. Karyawan wajib mencatat kehadiran saat datang dan saat pulang.',
    ],
  },
  {
    heading: 'Pasal 2 — Cuti Tahunan',
    body: [
      '1. Setiap karyawan berhak atas cuti tahunan sebanyak 12 hari kerja per tahun.',
      '2. Cuti tahunan baru boleh diambil setelah karyawan bekerja minimal 1 tahun.',
      '3. Pengajuan cuti tahunan disampaikan paling lambat 7 hari sebelum tanggal cuti.',
      '4. Cuti tahunan yang tidak diambil pada tahun berjalan tidak dapat diuangkan.',
    ],
  },
  {
    heading: 'Pasal 3 — Cuti Menikah',
    body: [
      '1. Karyawan yang menikah berhak atas cuti menikah selama 3 hari kerja.',
      '2. Cuti menikah dibayar penuh.',
      '3. Pengajuan cuti menikah disampaikan paling lambat 3 hari sebelum tanggal pernikahan.',
      '4. Pengajuan cuti menikah harus disertai salinan buku nikah.',
    ],
  },
  {
    heading: 'Pasal 4 — Cuti Melahirkan',
    body: [
      '1. Karyawan perempuan berhak atas cuti melahirkan selama 90 hari kalender.',
      '2. Cuti melahirkan dibayar penuh.',
      '3. Pengajuan cuti melahirkan disertai surat keterangan dari dokter.',
      '4. Cuti melahirkan tidak mengurangi jatah cuti tahunan.',
    ],
  },
  {
    heading: 'Pasal 5 — Izin Sakit',
    body: [
      '1. Karyawan yang sakit dapat mengajukan izin sakit kepada atasan langsung.',
      '2. Izin sakit tanpa surat dokter diberikan paling lama 1 hari.',
      '3. Izin sakit lebih dari 1 hari wajib dilampiri surat keterangan dokter.',
      '4. Izin sakit dicatat oleh bagian kepegawaian.',
    ],
  },
  {
    heading: 'Pasal 6 — Penggajian',
    body: [
      '1. Gaji karyawan dibayarkan setiap bulan pada tanggal 25.',
      '2. Jika tanggal 25 jatuh pada hari libur, gaji dibayarkan pada hari kerja berikutnya.',
      '3. Gaji ditransfer ke rekening bank yang terdaftar pada perusahaan.',
      '4. Slip gaji dikirim melalui email perusahaan.',
    ],
  },
  {
    heading: 'Pasal 7 — Pengunduran Diri',
    body: [
      '1. Karyawan yang mengundurkan diri wajib menyampaikan pemberitahuan tertulis.',
      '2. Notice period atau masa pemberitahuan resign adalah 30 hari.',
      '3. Masa notice period dihitung sejak surat pemberitahuan diterima perusahaan.',
      '4. Perusahaan dan karyawan dapat menyepakati pengurangan notice period secara tertulis.',
    ],
  },
  {
    heading: 'Pasal 8 — Sanksi Keterlambatan',
    body: [
      '1. Karyawan yang datang terlambat lebih dari 15 menit dikenakan teguran lisan.',
      '2. Keterlambatan ketiga dalam satu bulan dikenakan teguran tertulis.',
      '3. Keterlambatan berulang dapat dikenakan sanksi administratif sesuai kebijakan manajemen.',
      '4. Teguran disampaikan oleh atasan langsung dan dicatat oleh bagian kepegawaian.',
    ],
  },
  {
    heading: 'Pasal 9 — Ketentuan Umum',
    body: [
      '1. Peraturan Perusahaan ini berlaku bagi seluruh karyawan PT Contoh Sejahtera.',
      '2. Hal yang belum diatur dalam dokumen ini ditetapkan oleh manajemen perusahaan.',
      '3. Dokumen ini ditinjau paling sedikit setiap dua tahun.',
      '4. Setiap karyawan wajib memahami isi Peraturan Perusahaan ini.',
    ],
  },
  {
    heading: 'Pasal 10 — Kerahasiaan Informasi',
    body: [
      '1. Karyawan wajib menjaga kerahasiaan informasi milik perusahaan.',
      '2. Kewajiban menjaga kerahasiaan tetap berlaku setelah hubungan kerja berakhir.',
      '3. Informasi rahasia hanya boleh digunakan untuk kepentingan pekerjaan.',
      '4. Pelanggaran ketentuan ini dapat dikenakan sanksi sesuai peraturan yang berlaku.',
    ],
  },
  {
    heading: 'Pasal 11 — Penutup',
    body: [
      '1. Peraturan Perusahaan ini mulai berlaku pada tanggal ditetapkan.',
      '2. Dokumen ini bersifat fiktif dan hanya digunakan untuk pengujian perangkat lunak.',
      '3. Pertanyaan mengenai dokumen ini disampaikan kepada tim sumber daya manusia.',
      '',
      'Ditetapkan oleh:',
      'Manajemen PT Contoh Sejahtera',
    ],
  },
];

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return [''];
  }

  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) {
      lines.push(line);
    }

    line = word;
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function drawParagraph(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  startY: number,
  maxWidth: number,
  lineHeight: number,
  color = rgb(0.1, 0.1, 0.1),
): number {
  let y = startY;

  for (const line of wrapText(text, font, size, maxWidth)) {
    page.drawText(line, { x: MARGIN, y, size, font, color });
    y -= lineHeight;
  }

  return y;
}

function drawPageChrome(
  page: PDFPage,
  pageNumber: number,
  regularFont: PDFFont,
): void {
  const pageLabel = `Halaman ${pageNumber} dari ${TOTAL_PAGES}`;
  const pageLabelWidth = regularFont.widthOfTextAtSize(pageLabel, 9);

  page.drawLine({
    start: { x: MARGIN, y: 72 },
    end: { x: PAGE_WIDTH - MARGIN, y: 72 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });

  page.drawText(pageLabel, {
    x: PAGE_WIDTH - MARGIN - pageLabelWidth,
    y: 56,
    size: 9,
    font: regularFont,
    color: rgb(0.35, 0.35, 0.35),
  });

  page.drawText(FOOTER_TEXT, {
    x: MARGIN,
    y: 38,
    size: 8,
    font: regularFont,
    color: rgb(0.45, 0.45, 0.45),
  });
}

function drawCover(
  page: PDFPage,
  fixturePage: FixturePage,
  regularFont: PDFFont,
  boldFont: PDFFont,
): void {
  let y = 620;

  page.drawText(fixturePage.heading, {
    x: MARGIN,
    y,
    size: 26,
    font: boldFont,
    color: rgb(0.05, 0.05, 0.15),
  });
  y -= 38;

  if (fixturePage.subheading) {
    page.drawText(fixturePage.subheading, {
      x: MARGIN,
      y,
      size: 18,
      font: boldFont,
      color: rgb(0.15, 0.15, 0.25),
    });
    y -= 34;
  }

  const [note, ...rest] = fixturePage.body;

  page.drawText(note, {
    x: MARGIN,
    y,
    size: 13,
    font: regularFont,
    color: rgb(0.25, 0.25, 0.25),
  });
  y -= 40;

  for (const paragraph of rest) {
    if (!paragraph) {
      y -= BODY_LINE_HEIGHT;
      continue;
    }

    y = drawParagraph(
      page,
      paragraph,
      regularFont,
      BODY_SIZE,
      y,
      CONTENT_WIDTH,
      BODY_LINE_HEIGHT,
    );
    y -= 8;
  }

  if (y < 120) {
    throw new Error('Cover content overflows the page.');
  }
}

function drawArticlePage(
  page: PDFPage,
  fixturePage: FixturePage,
  regularFont: PDFFont,
  boldFont: PDFFont,
): void {
  page.drawText(fixturePage.heading, {
    x: MARGIN,
    y: 750,
    size: 16,
    font: boldFont,
    color: rgb(0.05, 0.05, 0.15),
  });

  page.drawLine({
    start: { x: MARGIN, y: 734 },
    end: { x: PAGE_WIDTH - MARGIN, y: 734 },
    thickness: 0.75,
    color: rgb(0.6, 0.6, 0.6),
  });

  let y = 700;

  for (const paragraph of fixturePage.body) {
    if (!paragraph) {
      y -= BODY_LINE_HEIGHT;
      continue;
    }

    y = drawParagraph(
      page,
      paragraph,
      regularFont,
      BODY_SIZE,
      y,
      CONTENT_WIDTH,
      BODY_LINE_HEIGHT,
    );
    y -= 10;
  }

  if (y < 110) {
    throw new Error(`Content overflows page: ${fixturePage.heading}`);
  }
}

async function generateFixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  pdf.setTitle('Peraturan Perusahaan PT Contoh Sejahtera (Dokumen Fiktif)');
  pdf.setAuthor('PT Contoh Sejahtera (fiktif)');
  pdf.setSubject('Dokumen fiktif untuk pengujian perangkat lunak');
  pdf.setCreator('askdoc-ai fixture generator');
  pdf.setProducer('pdf-lib');
  pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));

  const regularFont = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  PAGES.forEach((fixturePage, index) => {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    if (fixturePage.cover) {
      drawCover(page, fixturePage, regularFont, boldFont);
    } else {
      drawArticlePage(page, fixturePage, regularFont, boldFont);
    }

    drawPageChrome(page, index + 1, regularFont);
  });

  if (pdf.getPageCount() !== TOTAL_PAGES) {
    throw new Error(
      `Expected ${TOTAL_PAGES} fixture pages, got ${pdf.getPageCount()}.`,
    );
  }

  return pdf.save();
}

async function main(): Promise<void> {
  const outputPath = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'peraturan-perusahaan.pdf',
  );

  const bytes = await generateFixturePdf();

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);

  console.log(`Wrote ${TOTAL_PAGES}-page fixture to ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
