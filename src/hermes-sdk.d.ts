declare module '*.css' {
  const content: string
  export default content
}

declare module '@hermes/plugin-sdk' {
  import type { ComponentType, ReactNode } from 'react'

  export const ROUTES_AREA: string
  export const SIDEBAR_NAV_AREA: string
  export const PALETTE_AREA: string
  export const TITLEBAR_AREAS: { center: string; left: string; right: string }
  export interface ReadonlyAtom<T> {
    get(): T
    listen(listener: (value: T, previous: T) => void): () => void
  }
  export const host: {
    navigate(path: string): void
    notify(input: { kind: 'error' | 'info' | 'success' | 'warning'; message: string }): void
    state: { connectionId: ReadonlyAtom<null | string> }
  }
  export function useValue<T>(atom: ReadonlyAtom<T>): T
  export type PluginTranslate = (key: string, ...args: unknown[]) => string
  export function usePluginI18n(pluginId: string): PluginTranslate
  export interface PluginI18n {
    register(bundles: Record<string, unknown>): () => void
    t: PluginTranslate
    onLocaleChange(listener: () => void): () => void
  }
  export function useQuery<T>(options: {
    queryKey: readonly unknown[]
    queryFn: () => Promise<T>
    refetchInterval?: number
    refetchOnWindowFocus?: boolean
    enabled?: boolean
    placeholderData?: (previous: T | undefined) => T | undefined
    staleTime?: number
  }): { data?: T; error: unknown; isFetching: boolean; isLoading: boolean; refetch: () => Promise<unknown> }
  export function cn(...inputs: unknown[]): string
  export const Button: ComponentType<Record<string, unknown>>
  export const Codicon: ComponentType<Record<string, unknown>>
  export const Contribute: ComponentType<{ area: string; children: ReactNode; id: string }>
  export const CopyButton: ComponentType<Record<string, unknown>>
  export const DropdownMenu: ComponentType<Record<string, unknown>>
  export const DropdownMenuContent: ComponentType<Record<string, unknown>>
  export const DropdownMenuItem: ComponentType<Record<string, unknown>>
  export const DropdownMenuSeparator: ComponentType<Record<string, unknown>>
  export const DropdownMenuTrigger: ComponentType<Record<string, unknown>>
  export const EmptyState: ComponentType<Record<string, unknown>>
  export const ErrorState: ComponentType<Record<string, unknown>>
  export const Input: ComponentType<Record<string, unknown>>
  export const Loader: ComponentType<Record<string, unknown>>
  export const Popover: ComponentType<Record<string, unknown>>
  export const PopoverContent: ComponentType<Record<string, unknown>>
  export const PopoverTrigger: ComponentType<Record<string, unknown>>
  export const SearchField: ComponentType<Record<string, unknown>>
  export function SegmentedControl<T extends string>(props: {
    className?: string
    onChange: (id: T) => void
    options: readonly { id: T; label: string }[]
    value: T
  }): ReactNode
  export const Select: ComponentType<Record<string, unknown>>
  export const SelectContent: ComponentType<Record<string, unknown>>
  export const SelectItem: ComponentType<Record<string, unknown>>
  export const SelectTrigger: ComponentType<Record<string, unknown>>
  export const SelectValue: ComponentType<Record<string, unknown>>
  export const Switch: ComponentType<Record<string, unknown>>
  export const Textarea: ComponentType<Record<string, unknown>>
  export const Tip: ComponentType<Record<string, unknown>>
  export function profileColor(name: string): string
  export function profileColorSoft(color: string, alpha?: number): string

  export interface PluginStorage {
    get<T>(key: string, fallback: T): T
    set(key: string, value: unknown): void
  }

  export interface PluginContext {
    rest<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T>
    register(contribution: Record<string, unknown>): () => void
    registerMany(contributions: Record<string, unknown>[]): () => void
    onDispose(dispose: () => void): void
    storage: PluginStorage
    i18n: PluginI18n
  }
}
