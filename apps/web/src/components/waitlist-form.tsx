"use client";

import { useState, type FormEvent } from "react";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email) return;

    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Something went wrong");
      }

      setStatus("success");
      setEmail("");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  if (status === "success") {
    return (
      <div className="mt-8 rounded-xl border border-neutral-700 bg-neutral-900/50 px-6 py-8 text-center">
        <p className="text-lg font-semibold text-white">You&apos;re on the list.</p>
        <p className="mt-2 text-sm text-neutral-400">
          We&apos;ll reach out soon to schedule a demo.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
    >
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.com"
        className="w-full rounded-full border border-neutral-700 bg-transparent px-6 py-3 text-white placeholder-neutral-600 focus:border-white focus:outline-none sm:w-80"
      />
      <button
        type="submit"
        disabled={status === "loading"}
        className="rounded-full bg-white px-8 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200 disabled:opacity-50"
      >
        {status === "loading" ? "Submitting…" : "Get early access"}
      </button>
      {status === "error" && (
        <p className="text-sm text-red-400">{errorMsg}</p>
      )}
    </form>
  );
}
