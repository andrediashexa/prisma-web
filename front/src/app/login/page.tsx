import type { Metadata } from "next"
import { Suspense } from "react"

import { PrismaLogo } from "@/components/prisma-logo"

import { LoginForm } from "./login-form"

export const metadata: Metadata = { title: "Entrar" }

export default function LoginPage() {
  return (
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden p-6">
      {/* Feixes de luz difusos ao fundo, na paleta do prisma. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-chart-1/25 absolute -top-32 left-1/2 size-[36rem] -translate-x-[70%] rounded-full blur-3xl" />
        <div className="bg-chart-2/20 absolute top-1/3 left-1/2 size-[30rem] translate-x-[5%] rounded-full blur-3xl" />
        <div className="bg-chart-3/15 absolute -bottom-40 left-1/2 size-[28rem] -translate-x-1/2 rounded-full blur-3xl" />
      </div>

      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <PrismaLogo className="size-12 shadow-lg" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Prisma</h1>
            <p className="text-muted-foreground text-sm">Entre para gerenciar o roteador</p>
          </div>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  )
}
