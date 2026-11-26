// Blacks out the private details on a scanned page, on this laptop. The logic is in blackoutPlan.ts (pure, tested);
// this file only plugs in the real on-device redact() and the browser's canvas.
//
// Nothing here talks to the network. The image and the black-boxed copy stay on this laptop. The only thing a
// caller may send to the cloud is `redactedText` (placeholders, no real values), and only through draft().

import type { Engine, RedactionResult } from '../ai/redact.ts'
import type { OcrImage, OcrResult } from './ocr.ts'
import { runBlackout } from './blackoutPlan.ts'
import type { BlackoutParts, BlackoutResult, OpenedImage, PlanOptions, Rect } from './blackoutPlan.ts'
import { mustNotAppear, recheckPhoto } from './recheck.ts'

export type { BlackoutBox, BlackoutResult, BlockedReason, BoxSource, Rect } from './blackoutPlan.ts'

export type PageCanvas = HTMLCanvasElement | OffscreenCanvas

export interface BlackoutOptions extends PlanOptions {
  /** The engine from prepareRedaction(). Leave it out to pick the best one now (call from a button click). */
  engine?: Engine
  /** Names the person listed by hand, re-checked by redaction. */
  knownNames?: string[]
  /**
   * Use this on-device redaction instead (the app passes redactNotes(), so the scan follows the same engine choice
   * as the paste screen). `engine` and `knownNames` are then ignored.
   */
  redact?: (text: string) => Promise<RedactionResult>
  /**
   * Reads a blacked-out copy again (the same on-device text reader). Given, the copy is rechecked after painting and
   * any hidden detail still readable is covered too (recheck.ts); a detail still there after 2 rounds blocks the page.
   */
  reread?: (canvas: PageCanvas) => Promise<OcrResult>
  /** Called when the recheck starts, so the screen can say so. */
  onRecheck?: () => void
}

function newCanvas(width: number, height: number): PageCanvas {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  return new OffscreenCanvas(width, height)
}

async function toPng(canvas: PageCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' })
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The blacked-out copy couldn’t be saved as an image.')
  return blob
}

/**
 * Opens the page. Pass the same canvas you gave readText(), so the boxes land on the pixels that were read. A Blob
 * is decoded as stored (EXIF rotation ignored); a rotated photo is not checked here beyond its size.
 */
async function openImage(image: OcrImage): Promise<OpenedImage<PageCanvas>> {
  const source: CanvasImageSource =
    image instanceof Blob ? await createImageBitmap(image, { imageOrientation: 'none' }) : image
  const { width, height } = source as { width: number; height: number }
  return {
    width,
    height,
    async paint(rects: readonly Rect[]) {
      const canvas = newCanvas(width, height) // a copy: the original image is never drawn on
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
      if (!ctx) throw new Error('Canvas 2D is not available.')
      ctx.drawImage(source, 0, 0)
      ctx.fillStyle = '#000'
      for (const rect of rects) ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      if (source instanceof ImageBitmap) source.close()
      return { blob: await toPng(canvas), canvas }
    },
  }
}

/**
 * Redacts the page's OCR text on this device, then paints a solid black box over every hidden detail on a copy of
 * the image. Returns "blocked" (and paints nothing) when redaction is blocked or a detail can't be placed.
 */
export async function blackOut(
  image: OcrImage,
  ocr: OcrResult,
  options: BlackoutOptions = {},
): Promise<BlackoutResult<PageCanvas>> {
  const redactText = options.redact ?? (await defaultRedact(options))
  const parts: BlackoutParts<OcrImage, PageCanvas> = { redact: redactText, open: openImage }
  const reread = options.reread
  if (reread) {
    parts.recheck = (canvas, map, size) => {
      options.onRecheck?.()
      return recheckPhoto(canvas, mustNotAppear(map), { read: reread, paint: paintOver, size })
    }
  }
  return runBlackout(image, ocr, parts, options)
}

/** A copy of `canvas` with black boxes on it (the recheck's fixes). */
async function paintOver(canvas: PageCanvas, rects: readonly Rect[]): Promise<{ canvas: PageCanvas; blob: Blob }> {
  const copy = newCanvas(canvas.width, canvas.height)
  const ctx = copy.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error('Canvas 2D is not available.')
  ctx.drawImage(canvas, 0, 0)
  ctx.fillStyle = '#000'
  for (const rect of rects) ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
  return { canvas: copy, blob: await toPng(copy) }
}

async function defaultRedact(options: BlackoutOptions): Promise<(text: string) => Promise<RedactionResult>> {
  // Loaded on first use, so Firebase and the redaction models stay out of the first screen.
  const { prepareRedaction, redact } = await import('../ai/redact.ts')
  const engine = options.engine ?? (await prepareRedaction()).engine
  return (text) => redact(text, { engine, knownNames: options.knownNames })
}
