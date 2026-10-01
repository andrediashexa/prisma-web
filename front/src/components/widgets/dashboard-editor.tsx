"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { toast } from "sonner"
import {
  GripVerticalIcon,
  Loader2Icon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Settings2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useRouters } from "@/hooks/use-routers"
import { api, errorMessage, fetcher } from "@/lib/api"
import { routerApi, type RouterInterface, type RouterView } from "@/lib/types"
import { cn } from "@/lib/utils"

import { defaultLayout, newWidget, SIZE_CLASS, SIZE_LABEL, WIDGETS, widgetTitle, WidgetView } from "./registry"
import type { DashboardLayout, Widget, WidgetConfig, WidgetSize, WidgetType } from "./types"

const ALL_ROUTERS = "__all__"

export function DashboardEditor() {
  const { data: routers } = useRouters()
  const { data: saved, mutate } = useSWR<{ layout: DashboardLayout | null }>("/dashboard", fetcher)
  const [draft, setDraft] = useState<DashboardLayout | null>(null)
  const [saving, setSaving] = useState(false)
  const [adding, setAdding] = useState(false)
  const [configuring, setConfiguring] = useState<Widget | null>(null)

  // O padrão gera ids novos; sem memo, os widgets remontariam a cada revalidação do SWR.
  const current = useMemo(
    () => (saved && routers ? (saved.layout ?? defaultLayout(routers)) : null),
    [saved, routers],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  if (!current || !routers) {
    return (
      <>
        <PageHeader title="Visão geral" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </>
    )
  }

  const editing = draft !== null
  const layout = draft ?? current
  const update = (fn: (w: Widget[]) => Widget[]) => setDraft((d) => ({ version: 1, widgets: fn((d ?? current).widgets) }))

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      await api.put("/dashboard", draft)
      await mutate({ layout: draft }, { revalidate: false })
      setDraft(null)
      toast.success("Página salva")
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    setSaving(true)
    try {
      await api.delete("/dashboard")
      await mutate({ layout: null }, { revalidate: false })
      setDraft(null)
      toast.success("Página restaurada para o padrão")
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return
    update((ws) => {
      const from = ws.findIndex((w) => w.id === e.active.id)
      const to = ws.findIndex((w) => w.id === e.over!.id)
      return arrayMove(ws, from, to)
    })
  }

  return (
    <>
      <PageHeader
        title="Visão geral"
        description={editing ? "Arraste os widgets para reordenar. Use o menu de cada um para ajustar tamanho e dados." : "Sua página inicial personalizada"}
      >
        {editing ? (
          <>
            <Button variant="ghost" onClick={reset} disabled={saving}>
              <RotateCcwIcon /> Restaurar padrão
            </Button>
            <Button variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon /> Adicionar widget
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              <XIcon /> Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Salvar
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={() => setDraft(current)}>
            <PencilIcon /> Personalizar
          </Button>
        )}
      </PageHeader>

      {layout.widgets.length === 0 && (
        <div className="text-muted-foreground flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-sm">
          Nenhum widget nesta página.
          <Button variant="outline" onClick={() => { if (!editing) setDraft(current); setAdding(true) }}>
            <PlusIcon /> Adicionar widget
          </Button>
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={layout.widgets.map((w) => w.id)} strategy={rectSortingStrategy} disabled={!editing}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {layout.widgets.map((w) => (
              <SortableWidget
                key={w.id}
                widget={w}
                routers={routers}
                editing={editing}
                onResize={(size) => update((ws) => ws.map((x) => (x.id === w.id ? { ...x, size } : x)))}
                onRemove={() => update((ws) => ws.filter((x) => x.id !== w.id))}
                onConfigure={() => setConfiguring(w)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <AddWidgetDialog
        open={adding}
        routers={routers}
        onClose={() => setAdding(false)}
        onAdd={(w) => {
          update((ws) => [...ws, w])
          setAdding(false)
        }}
      />
      <ConfigureDialog
        widget={configuring}
        routers={routers}
        onClose={() => setConfiguring(null)}
        onSave={(config) => {
          update((ws) => ws.map((x) => (x.id === configuring?.id ? { ...x, config } : x)))
          setConfiguring(null)
        }}
      />
    </>
  )
}

function SortableWidget({
  widget,
  routers,
  editing,
  onResize,
  onRemove,
  onConfigure,
}: {
  widget: Widget
  routers: RouterView[]
  editing: boolean
  onResize: (s: WidgetSize) => void
  onRemove: () => void
  onConfigure: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: widget.id,
  })
  const def = WIDGETS[widget.type]
  const configurable = def && (def.perRouter || def.optionalRouter)

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("flex min-w-0 flex-col", SIZE_CLASS[widget.size], isDragging && "z-10 opacity-80")}
    >
      {editing && (
        <div className="bg-muted/60 mb-2 flex items-center gap-1 rounded-lg border p-1 pl-1">
          <Button
            type="button"
            ref={setActivatorNodeRef}
            variant="ghost"
            size="icon"
            className="size-7 cursor-grab active:cursor-grabbing"
            aria-label="Arrastar"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon />
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{widgetTitle(widget, routers)}</span>
          <span className="text-muted-foreground hidden text-xs sm:inline">{SIZE_LABEL[widget.size]}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Opções do widget">
                <MoreVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {configurable && (
                <>
                  <DropdownMenuItem onSelect={onConfigure}>
                    <Settings2Icon /> Configurar
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel>Largura</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={String(widget.size)} onValueChange={(v) => onResize(Number(v) as WidgetSize)}>
                {([1, 2, 3, 4] as WidgetSize[]).map((s) => (
                  <DropdownMenuRadioItem key={s} value={String(s)}>
                    {SIZE_LABEL[s]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2Icon /> Remover
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className={cn("flex-1", editing && "pointer-events-none opacity-90 select-none")}>
        <WidgetView widget={widget} routers={routers} />
      </div>
    </div>
  )
}

function AddWidgetDialog({
  open,
  routers,
  onClose,
  onAdd,
}: {
  open: boolean
  routers: RouterView[]
  onClose: () => void
  onAdd: (w: Widget) => void
}) {
  const [picked, setPicked] = useState<WidgetType | null>(null)
  const close = () => {
    setPicked(null)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{picked ? `Configurar: ${WIDGETS[picked].title}` : "Adicionar widget"}</DialogTitle>
          <DialogDescription>
            {picked ? "Escolha de qual Prisma o widget mostra os dados." : "Escolha o que mostrar na sua página inicial."}
          </DialogDescription>
        </DialogHeader>
        {picked ? (
          <WidgetConfigForm
            type={picked}
            routers={routers}
            initial={{ routerId: routers[0]?.id, minutes: 60 }}
            submitLabel="Adicionar"
            onCancel={() => setPicked(null)}
            onSubmit={(config) => {
              onAdd(newWidget(picked, config))
              setPicked(null)
            }}
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(WIDGETS) as WidgetType[]).map((type) => {
              const def = WIDGETS[type]
              const blocked = def.perRouter && routers.length === 0
              return (
                <button
                  key={type}
                  type="button"
                  disabled={blocked}
                  onClick={() => (def.perRouter || def.optionalRouter ? setPicked(type) : onAdd(newWidget(type)))}
                  className="hover:border-primary/50 hover:bg-accent/50 flex items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <def.icon className="size-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-medium">{def.title}</span>
                    <span className="text-muted-foreground block text-xs">
                      {blocked ? "Cadastre um roteador primeiro" : def.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ConfigureDialog({
  widget,
  routers,
  onClose,
  onSave,
}: {
  widget: Widget | null
  routers: RouterView[]
  onClose: () => void
  onSave: (c: WidgetConfig) => void
}) {
  return (
    <Dialog open={!!widget} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configurar {widget && WIDGETS[widget.type]?.title}</DialogTitle>
          <DialogDescription>Escolha de onde vêm os dados deste widget.</DialogDescription>
        </DialogHeader>
        {widget && (
          <WidgetConfigForm
            key={widget.id}
            type={widget.type}
            routers={routers}
            initial={widget.config}
            submitLabel="Aplicar"
            onCancel={onClose}
            onSubmit={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function WidgetConfigForm({
  type,
  routers,
  initial,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  type: WidgetType
  routers: RouterView[]
  initial: WidgetConfig
  submitLabel: string
  onCancel: () => void
  onSubmit: (c: WidgetConfig) => void
}) {
  const def = WIDGETS[type]
  const [routerId, setRouterId] = useState(initial.routerId ?? (def.perRouter ? routers[0]?.id : undefined))
  const [iface, setIface] = useState(initial.interface)
  const [minutes, setMinutes] = useState(String(initial.minutes ?? 60))
  const { data: ifaces } = useSWR<{ interfaces: RouterInterface[] }>(
    def.traffic && routerId ? routerApi(routerId, "/interfaces") : null,
    fetcher,
  )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(def.traffic ? { routerId, interface: iface, minutes: Number(minutes) } : { routerId })
      }}
    >
      <FieldGroup className="py-2">
        <Field>
          <FieldLabel>Roteador</FieldLabel>
          <Select
            value={routerId ?? ALL_ROUTERS}
            onValueChange={(v) => {
              setRouterId(v === ALL_ROUTERS ? undefined : v)
              setIface(undefined)
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {def.optionalRouter && <SelectItem value={ALL_ROUTERS}>Todos os roteadores</SelectItem>}
              {routers.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {def.traffic && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Interface inicial</FieldLabel>
              <Select value={iface ?? ""} onValueChange={setIface} disabled={!ifaces}>
                <SelectTrigger>
                  <SelectValue placeholder={ifaces ? "Primeira disponível" : "Carregando…"} />
                </SelectTrigger>
                <SelectContent>
                  {ifaces?.interfaces
                    .filter((i) => i.name !== "lo")
                    .map((i) => (
                      <SelectItem key={i.name} value={i.name}>
                        {i.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Período inicial</FieldLabel>
              <Select value={minutes} onValueChange={setMinutes}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutos</SelectItem>
                  <SelectItem value="60">1 hora</SelectItem>
                  <SelectItem value="360">6 horas</SelectItem>
                  <SelectItem value="1440">24 horas</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
      </FieldGroup>
      <DialogFooter className="pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Voltar
        </Button>
        <Button type="submit" disabled={def.perRouter && !routerId}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
