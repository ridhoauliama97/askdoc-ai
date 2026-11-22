export const MAX_PDF_MB = 15;
export const MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const MAX_ACTIVE_DOCUMENTS = 5;
export const DOCUMENT_TTL_HOURS = 24;

export const PDF_CONTENT_TYPE = 'application/pdf';

export const INVALID_PDF_MESSAGE = 'File harus berformat PDF.';
export const FILE_TOO_LARGE_MESSAGE = `Ukuran file melebihi ${MAX_PDF_MB} MB.`;
export const DOC_LIMIT_MESSAGE =
  `Maksimal ${MAX_ACTIVE_DOCUMENTS} dokumen aktif. Hapus dokumen lama untuk mengunggah lagi.`;
export const GLOBAL_LIMIT_MESSAGE =
  'Kuota demo hari ini sudah habis. Silakan kembali besok ya.';
export const UPLOAD_GENERIC_MESSAGE = 'Gagal mengunggah dokumen. Coba lagi.';
export const UPLOAD_RETRY_FAILED_MESSAGE = 'Upload gagal. Coba lagi.';
export const DOCUMENTS_LOAD_MESSAGE = 'Gagal memuat dokumen. Coba lagi.';

export type ApiErrorPayload = {
  code?: string;
  message?: string;
  retryAfter?: number;
};

export function validatePdfFile(
  file: Pick<File, 'name' | 'size'>,
): string | null {
  if (!file.name.trim().toLowerCase().endsWith('.pdf')) {
    return INVALID_PDF_MESSAGE;
  }

  if (file.size > MAX_PDF_BYTES) {
    return FILE_TOO_LARGE_MESSAGE;
  }

  return null;
}

export function getUploadErrorMessage(
  error: ApiErrorPayload | null | undefined,
): string {
  switch (error?.code) {
    case 'FILE_TOO_LARGE':
      return FILE_TOO_LARGE_MESSAGE;
    case 'DOC_LIMIT_REACHED':
      return DOC_LIMIT_MESSAGE;
    case 'GLOBAL_LIMIT_REACHED':
      return GLOBAL_LIMIT_MESSAGE;
    case 'RATE_LIMITED':
      return error.retryAfter
        ? `Terlalu banyak permintaan. Coba lagi dalam ${error.retryAfter} detik.`
        : 'Terlalu banyak permintaan. Coba lagi sebentar lagi.';
    default:
      return error?.message?.trim() || UPLOAD_GENERIC_MESSAGE;
  }
}
