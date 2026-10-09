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

  // The default layout generates new ids; without memo, widgets would remount on every SWR revalidation.
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
        <PageHeader title="Overview" />
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
      toast.success("Page saved")
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
      toast.success("Page reset to default")
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
        title="Overview"
        description={editing ? "Drag widgets to reorder them. Use each widget's menu to adjust its size and data." : "Your personalized home page"}
      >
        {editing ? (
          <>
            <Button variant="ghost" onClick={reset} disabled={saving}>
              <RotateCcwIcon /> Reset to default
            </Button>
            <Button variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon /> Add widget
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              <XIcon /> Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={() => setDraft(current)}>
            <PencilIcon /> Customize
          </Button>
        )}
      </PageHeader>

      {layout.widgets.length === 0 && (
        <div className="text-muted-foreground flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-sm">
          No widgets on this page.
          <Button variant="outline" onClick={() => { if (!editing) setDraft(current); setAdding(true) }}>
            <PlusIcon /> Add widget
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
            aria-label="Drag"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon />
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{widgetTitle(widget, routers)}</span>
          <span className="text-muted-foreground hidden text-xs sm:inline">{SIZE_LABEL[widget.size]}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label="Widget options">
                <MoreVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {configurable && (
                <>
                  <DropdownMenuItem onSelect={onConfigure}>
                    <Settings2Icon /> Configure
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel>Width</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={String(widget.size)} onValueChange={(v) => onResize(Number(v) as WidgetSize)}>
                {([1, 2, 3, 4] as WidgetSize[]).map((s) => (
                  <DropdownMenuRadioItem key={s} value={String(s)}>
                    {SIZE_LABEL[s]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2Icon /> Remove
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
          <DialogTitle>{picked ? `Configure: ${WIDGETS[picked].title}` : "Add widget"}</DialogTitle>
          <DialogDescription>
            {picked ? "Choose which router the widget shows data from." : "Choose what to show on your home page."}
          </DialogDescription>
        </DialogHeader>
        {picked ? (
          <WidgetConfigForm
            type={picked}
            routers={routers}
            initial={{ routerId: routers[0]?.id, minutes: 60 }}
            submitLabel="Add"
            onCancel={() => setPicked(null)}
            onSubmit={(config) => {
              onAdd(newWidget(picked, config))
              setPicked(null)
            }}
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                      {blocked ? "Add a router first" : def.description}
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
          <DialogTitle>Configure {widget && WIDGETS[widget.type]?.title}</DialogTitle>
          <DialogDescription>Choose where this widget&apos;s data comes from.</DialogDescription>
        </DialogHeader>
        {widget && (
          <WidgetConfigForm
            key={widget.id}
            type={widget.type}
            routers={routers}
            initial={widget.config}
            submitLabel="Apply"
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
  const [view, setView] = useState(def.views?.some((v) => v.value === initial.view) ? initial.view! : (def.views?.[0].value ?? ""))
  const { data: ifaces } = useSWR<{ interfaces: RouterInterface[] }>(
    def.traffic && routerId ? routerApi(routerId, "/interfaces") : null,
    fetcher,
  )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(def.traffic ? { routerId, interface: iface, minutes: Number(minutes) } : { routerId, ...(def.views && { view }), ...(def.range && { minutes: Number(minutes) }) })
      }}
    >
      <FieldGroup className="py-2">
        <Field>
          <FieldLabel>Router</FieldLabel>
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
              {def.optionalRouter && <SelectItem value={ALL_ROUTERS}>All routers</SelectItem>}
              {routers.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {def.views && (
          <Field>
            <FieldLabel>View</FieldLabel>
            <Select value={view} onValueChange={setView}>
              <SelectTrigger aria-label="View">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {def.views.map((v) => (
                  <SelectItem key={v.value} value={v.value}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {def.range && (
          <Field>
            <FieldLabel>Initial range</FieldLabel>
            <Select value={minutes} onValueChange={setMinutes}>
              <SelectTrigger aria-label="Initial range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
                <SelectItem value="360">6 hours</SelectItem>
                <SelectItem value="1440">24 hours</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
        {def.traffic && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel>Initial interface</FieldLabel>
              <Select value={iface ?? ""} onValueChange={setIface} disabled={!ifaces}>
                <SelectTrigger>
                  <SelectValue placeholder={ifaces ? "First available" : "Loading…"} />
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
              <FieldLabel>Initial range</FieldLabel>
              <Select value={minutes} onValueChange={setMinutes}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="360">6 hours</SelectItem>
                  <SelectItem value="1440">24 hours</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
      </FieldGroup>
      <DialogFooter className="pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Back
        </Button>
        <Button type="submit" disabled={def.perRouter && !routerId}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
