'use client';

import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { LoaderCircle, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type UploadButtonProps = {
  onUpload: (file: File) => void | Promise<unknown>;
  disabled?: boolean;
  isUploading?: boolean;
  className?: string;
};

export function UploadButton({
  onUpload,
  disabled = false,
  isUploading = false,
  className,
}: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const blocked = disabled || isUploading;

  function handleFile(file: File | undefined) {
    if (file) {
      void onUpload(file);
    }
  }

  function openFilePicker() {
    if (blocked) {
      return;
    }

    inputRef.current?.click();
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    handleFile(file);
    event.target.value = '';
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();

    if (!blocked) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragging(false);

    if (blocked) {
      return;
    }

    handleFile(event.dataTransfer.files?.[0]);
  }

  return (
    <>
      <Button
        type="button"
        disabled={blocked}
        aria-busy={isUploading}
        onClick={openFilePicker}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'w-full',
          isDragging && 'ring-3 ring-primary/30',
          className,
        )}
      >
        {isUploading ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" />
        ) : (
          <Upload aria-hidden="true" />
        )}
        {isUploading ? 'Mengunggah…' : 'Upload PDF'}
      </Button>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={handleChange}
      />
    </>
  );
}
