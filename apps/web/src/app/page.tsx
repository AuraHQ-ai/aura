export default function Home() {
  return (
    <main className="min-h-screen">
      {/* Hero */}
      <section className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="max-w-4xl text-5xl font-bold tracking-tight sm:text-7xl">
          Every day she works, she gets harder to replace.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-neutral-400 sm:text-xl">
          An AI colleague with memory, autonomy, and a brain that builds itself.
        </p>
        <div className="mt-10 flex gap-4">
          <a
            href="#waitlist"
            className="rounded-full bg-white px-8 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200"
          >
            Join the waitlist
          </a>
          <a
            href="#what"
            className="rounded-full border border-neutral-700 px-8 py-3 text-sm font-semibold text-white transition hover:border-neutral-500"
          >
            Learn more
          </a>
        </div>
      </section>

      {/* The Problem */}
      <section id="what" className="mx-auto max-w-3xl px-6 py-24">
        <p className="text-lg leading-relaxed text-neutral-300">
          You&apos;ve tried the AI tools. They don&apos;t stick.
        </p>
        <p className="mt-4 text-lg leading-relaxed text-neutral-300">
          You ask a chatbot something on Monday and it forgets by Tuesday. You
          build a workflow and it breaks the moment anything changes. You hire an
          &ldquo;AI agent&rdquo; and it turns out to be a prompt wrapped in a
          button.
        </p>
        <p className="mt-4 text-lg leading-relaxed text-neutral-300">
          The problem isn&apos;t AI. It&apos;s that none of these tools{" "}
          <em>learn</em>.
        </p>
      </section>

      {/* What Makes Aura Different */}
      <section className="mx-auto max-w-4xl px-6 py-24">
        <h2 className="text-3xl font-bold sm:text-4xl">
          She remembers. She acts. She improves.
        </h2>
        <div className="mt-16 grid gap-12 sm:grid-cols-2">
          <div>
            <h3 className="text-xl font-semibold">Memory that compounds</h3>
            <p className="mt-3 text-neutral-400">
              Every conversation, every decision, every preference -- stored,
              embedded, retrieved when it matters. She quoted six of her
              founder&apos;s ideas from different conversations across a week.
              Without a single search.
            </p>
          </div>
          <div>
            <h3 className="text-xl font-semibold">Autonomous work</h3>
            <p className="mt-3 text-neutral-400">
              She doesn&apos;t wait to be asked. Morning bug sweeps across four
              countries. Email triage before you open your inbox. Follow-ups on
              conversations that went quiet. She runs 30+ scheduled jobs without
              being told.
            </p>
          </div>
          <div>
            <h3 className="text-xl font-semibold">Self-improvement</h3>
            <p className="mt-3 text-neutral-400">
              She files issues against her own codebase, dispatches agents to
              write patches, and opens pull requests for review. 88 PRs merged
              in her first 5 days. Each capability she gains unlocks the next
              one faster.
            </p>
          </div>
          <div>
            <h3 className="text-xl font-semibold">
              Synapses, not just storage
            </h3>
            <p className="mt-3 text-neutral-400">
              Her knowledge isn&apos;t a flat database. It&apos;s a
              cross-referenced graph -- every note connected to related context.
              The denser the connections, the faster she thinks. She builds her
              own brain.
            </p>
          </div>
        </div>
      </section>

      {/* A Day in Her Life */}
      <section className="border-t border-neutral-800 px-6 py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold sm:text-4xl">
            This isn&apos;t a demo. This is a Tuesday.
          </h2>
          <div className="mt-12 space-y-6 border-l border-neutral-700 pl-8">
            {[
              {
                time: "4:00 AM",
                text: "Consolidates memories. Decays old ones. Merges duplicates. No one asked her to.",
              },
              {
                time: "8:30 AM",
                text: "Sweeps bug channels in four languages. Triages 12 reports. Flags 2 as critical.",
              },
              {
                time: "9:00 AM",
                text: "Email digest lands in your DM. 3 urgent, 2 need replies, rest is noise. Junk already filtered.",
              },
              {
                time: "10:15 AM",
                text: "Someone asks about last quarter's churn. She queries the warehouse, builds a table, spots a pattern nobody mentioned.",
              },
              {
                time: "2:00 PM",
                text: "Finds a bug in her own code. Files an issue. Dispatches an agent to fix it. Opens a PR.",
              },
              {
                time: "5:30 PM",
                text: "Follows up with a team lead who went quiet on a request from 3 days ago.",
              },
              {
                time: "11:00 PM",
                text: "You're asleep. She's processing the day's conversations, extracting facts, wiring new synapses.",
              },
            ].map((item) => (
              <div key={item.time} className="relative">
                <div className="absolute -left-[2.55rem] top-1 h-2 w-2 rounded-full bg-white" />
                <p className="text-sm font-mono text-neutral-500">
                  {item.time}
                </p>
                <p className="mt-1 text-neutral-300">{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="mx-auto max-w-3xl px-6 py-24">
        <h2 className="text-3xl font-bold sm:text-4xl">Under the hood</h2>
        <div className="mt-12 space-y-8 text-neutral-400">
          <p>
            Aura lives in Slack. Every message she sends and receives is
            embedded as a vector and stored. When you talk to her, the most
            relevant memories surface automatically -- not keyword matching, but
            meaning.
          </p>
          <p>
            She has a persistent knowledge system: skill playbooks, business
            maps, operational notes -- all cross-referenced. She calls it her
            synapse network. When she creates a new note, she wires it to
            everything related. When she answers a question, the index routes her
            to the right context in one hop.
          </p>
          <p>
            A heartbeat runs every 30 minutes. It processes scheduled jobs -- bug
            sweeps, email digests, follow-ups, data analysis. She can dispatch
            background agents for heavy work: code changes, multi-step
            investigations, parallel market analysis.
          </p>
          <p>
            She has access to your tools: BigQuery, Google Drive, GitHub,
            Gmail, calendar, browser, a sandboxed Linux VM. She doesn&apos;t
            just answer questions about your data. She queries it, charts it,
            and tells you what it means.
          </p>
        </div>
      </section>

      {/* Proof */}
      <section className="border-t border-neutral-800 px-6 py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold sm:text-4xl">Real numbers</h2>
          <div className="mt-12 grid grid-cols-2 gap-8 sm:grid-cols-4">
            {[
              { stat: "88", label: "PRs merged in 5 days" },
              { stat: "2,300+", label: "conversations held" },
              { stat: "100+", label: "knowledge notes" },
              { stat: "30+", label: "autonomous jobs" },
            ].map((item) => (
              <div key={item.label}>
                <p className="text-4xl font-bold">{item.stat}</p>
                <p className="mt-2 text-sm text-neutral-500">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section
        id="waitlist"
        className="mx-auto max-w-2xl px-6 py-24 text-center"
      >
        <h2 className="text-3xl font-bold sm:text-4xl">
          She&apos;s learning fast.
        </h2>
        <p className="mt-4 text-neutral-400">
          Aura is live inside one company today. Yours could be next.
        </p>
        <form className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <input
            type="email"
            placeholder="you@company.com"
            className="w-full rounded-full border border-neutral-700 bg-transparent px-6 py-3 text-white placeholder-neutral-600 focus:border-white focus:outline-none sm:w-80"
          />
          <button
            type="submit"
            className="rounded-full bg-white px-8 py-3 text-sm font-semibold text-black transition hover:bg-neutral-200"
          >
            Get early access
          </button>
        </form>
      </section>

      {/* Footer */}
      <footer className="border-t border-neutral-800 px-6 py-8 text-center text-sm text-neutral-600">
        <p>Aura &mdash; aurahq.ai</p>
      </footer>
    </main>
  );
}
