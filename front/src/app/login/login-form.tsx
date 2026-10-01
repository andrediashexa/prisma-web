"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { api, errorMessage } from "@/lib/api"

export function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    try {
      await api.post("/auth/login", {
        username: form.get("username"),
        password: form.get("password"),
      })
      const next = params.get("next")
      // Only accept internal paths to avoid an open redirect.
      router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/")
    } catch (err) {
      setError(errorMessage(err))
      setPending(false)
    }
  }

  return (
    <Card className="bg-card/80 backdrop-blur">
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="username">Username</FieldLabel>
              <Input id="username" name="username" autoComplete="username" autoFocus required />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </Field>
            {error && <FieldError>{error}</FieldError>}
            <Button type="submit" disabled={pending} className="w-full">
              {pending && <Loader2Icon className="animate-spin" />}
              Sign in
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
