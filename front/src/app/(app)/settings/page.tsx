"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Loader2Icon } from "lucide-react"

import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useMe } from "@/hooks/use-me"
import { api, errorMessage } from "@/lib/api"
import { PASSWORD_MIN_LEN } from "@/lib/types"

export default function SettingsPage() {
  const { mutate } = useMe()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formEl = e.currentTarget
    const form = new FormData(formEl)
    if (form.get("new_password") !== form.get("confirm")) {
      setError("The confirmation does not match the new password")
      return
    }
    setPending(true)
    setError(null)
    try {
      await api.post("/auth/password", {
        current_password: form.get("current_password"),
        new_password: form.get("new_password"),
      })
      toast.success("Password changed. Your other sessions were signed out.")
      formEl.reset()
      await mutate()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <PageHeader title="My account" />
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>Changing it signs out every other open session of your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="current_password">Current password</FieldLabel>
                <Input id="current_password" name="current_password" type="password" required autoComplete="current-password" />
              </Field>
              <Field>
                <FieldLabel htmlFor="new_password">New password</FieldLabel>
                <Input id="new_password" name="new_password" type="password" required minLength={PASSWORD_MIN_LEN} autoComplete="new-password" />
                <FieldDescription>At least {PASSWORD_MIN_LEN} characters.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
                <Input id="confirm" name="confirm" type="password" required minLength={PASSWORD_MIN_LEN} autoComplete="new-password" />
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <Button type="submit" disabled={pending} className="w-fit">
                {pending && <Loader2Icon className="animate-spin" />}
                Save new password
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </>
  )
}
