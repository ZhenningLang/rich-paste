// Plugin settings (U-BEH-8): nine values in ctx.storage, normalised on read.

import type { ConvertMode } from './convert.ts'

export interface RichPasteSettings {
  /** smart (default, dogfood 11-07) / always / never. Replaces the old auto_convert switch. */
  convert_mode: ConvertMode
  limit_images: boolean
  max_images: number
  limit_image_size: boolean
  max_image_mb: number
  cache_auto_delete: boolean
  cache_days: number
  cache_dir: string
  /** Hermes' local STT model for this plugin's 转写; '' follows Hermes' own setting (11-08). */
  stt_model: SttModel
}

export type SttModel = '' | 'base' | 'small' | 'turbo'
export const STT_MODELS: readonly SttModel[] = ['', 'base', 'small', 'turbo']

export const DEFAULTS: Readonly<RichPasteSettings> = Object.freeze({
  convert_mode: 'smart',
  limit_images: false,
  max_images: 10,
  limit_image_size: false,
  max_image_mb: 10,
  cache_auto_delete: true,
  cache_days: 7,
  cache_dir: '',
  stt_model: ''
})

export const KEYS = Object.keys(DEFAULTS) as (keyof RichPasteSettings)[]

const CONVERT_MODES = new Set<ConvertMode>(['smart', 'always', 'never'])

export type NumberKey = 'max_images' | 'max_image_mb' | 'cache_days'

const NUMBER_KEYS = new Set<keyof RichPasteSettings>(['max_images', 'max_image_mb', 'cache_days'] satisfies NumberKey[])

/** A whole number >= 1, else the fallback. Accepts numeric strings ("12"). */
export function normalizeCount(value: unknown, fallback: number): number {
  if (typeof value === 'boolean' || value === null || value === undefined) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.floor(n)
}

export function normalizeSettings(raw: Partial<Record<keyof RichPasteSettings | 'auto_convert', unknown>> | null | undefined): RichPasteSettings {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULTS } as RichPasteSettings
  for (const key of KEYS) {
    const value = (src as Record<string, unknown>)[key]
    if (key === 'convert_mode') {
      out.convert_mode = CONVERT_MODES.has(value as ConvertMode)
        ? (value as ConvertMode)
        : (src as Record<string, unknown>).auto_convert === true ? 'always' : 'smart' // old switch on → always
    } else if (NUMBER_KEYS.has(key)) {
      ;(out as unknown as Record<string, number>)[key] = normalizeCount(value, DEFAULTS[key] as number)
    } else if (key === 'stt_model') {
      out.stt_model = STT_MODELS.includes(value as SttModel) ? (value as SttModel) : ''
    } else if (key === 'cache_dir') {
      out.cache_dir = typeof value === 'string' ? value.trim() : ''
    } else {
      ;(out as unknown as Record<string, boolean>)[key] = typeof value === 'boolean' ? value : (DEFAULTS[key] as boolean)
    }
  }
  return out
}

export interface StorageLike {
  get: <T>(key: string, fallback: T) => T
  set: (key: string, value: unknown) => void
}

export function readSettings(storage: StorageLike): RichPasteSettings {
  const raw: Record<string, unknown> = {}
  for (const key of KEYS) raw[key] = storage.get<unknown>(key, undefined)
  raw.auto_convert = storage.get<unknown>('auto_convert', undefined) // read only to carry over the old switch
  return normalizeSettings(raw)
}

/** The body fields the backend `/fetch-images` route takes. Switch off = unlimited (null). */
export function fetchParams(s: RichPasteSettings) {
  return {
    limits: {
      max_images: s.limit_images ? s.max_images : null,
      max_mb: s.limit_image_size ? s.max_image_mb : null
    },
    cache_dir: s.cache_dir,
    cleanup: { auto_delete: s.cache_auto_delete, days: s.cache_days }
  }
}
