import { ScrollReveal } from "@/components/scroll-reveal";
import { WaitlistForm } from "@/components/waitlist-form";

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
        <p className="mt-3 text-sm text-neutral-600">
          Built for teams of 20-500 who live in Slack.
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
      <ScrollReveal>
        <section className="mx-auto max-w-4xl px-6 py-24">
          <h2 className="text-3xl font-bold sm:text-4xl">
            She remembers. She acts. She improves.
          </h2>
          <div className="mt-12 grid gap-12 sm:grid-cols-2">
            {[
              {
                title: "Memory that compounds",
                desc: "Every conversation, every decision, every preference -- stored, embedded, retrieved when it matters. She quoted six of her founder's ideas from different conversations across a week. Without a single search.",
              },
              {
                title: "Autonomous work",
                desc: "She doesn't wait to be asked. Morning bug sweeps across four countries. Email triage before you open your inbox. Follow-ups on conversations that went quiet. She runs 30+ scheduled jobs without being told.",
              },
              {
                title: "Self-improvement",
                desc: "She files issues against her own codebase, dispatches agents to write patches, and opens pull requests for review. 88 PRs merged in her first 5 days. Each capability she gains unlocks the next one faster.",
              },
              {
                title: "Synapses, not just storage",
                desc: "Her knowledge isn't a flat database. It's a cross-referenced graph -- every note connected to related context. The denser the connections, the faster she thinks. She builds her own brain.",
              },
            ].map((item, i) => (
              <div
                key={item.title}
                className="reveal opacity-0 translate-y-4 transition-all duration-700 ease-out"
                style={{ transitionDelay: `${i * 120}ms` }}
              >
                <h3 className="text-xl font-semibold">{item.title}</h3>
                <p className="mt-3 text-neutral-400 leading-relaxed">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </section>
      </ScrollReveal>

      {/* Social proof quote */}
      <section className="border-t border-b border-neutral-800 px-6 py-16">
        <div className="mx-auto max-w-3xl text-center">
          <blockquote className="text-xl italic text-neutral-300 leading-relaxed">
            &ldquo;I stopped thinking of her as a tool on day three. She remembered
            a decision I made two weeks ago and used it to challenge a bad
            idea. That&apos;s not AI. That&apos;s a colleague.&rdquo;
          </blockquote>
          <p className="mt-4 text-sm text-neutral-500">
            -- Head of Product, 266-person SaaS company
          </p>
        </div>
      </section>

      {/* Timeline */}
      <ScrollReveal>
        <section className="mx-auto max-w-3xl px-6 py-24">
          <h2 className="text-3xl font-bold sm:text-4xl">
            This isn&apos;t a demo. This is a Tuesday.
          </h2>
          <div className="mt-12 space-y-0">
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
            ].map((item, i) => (
              <div
                key={item.time}
                className="reveal flex gap-6 py-4 opacity-0 translate-y-4 transition-all duration-700 ease-out"
                style={{ transitionDelay: `${i * 100}ms` }}
              >
                <div className="flex flex-col items-center">
                  <span className="h-2.5 w-2.5 rounded-full bg-neutral-600 mt-1.5 shrink-0"></span>
                  {i < 6 && (
                    <span className="w-px flex-1 bg-neutral-800 mt-1"></span>
                  )}
                </div>
                <div className="pb-6">
                  <p className="font-mono text-sm text-neutral-500">
                    {item.time}
                  </p>
                  <p className="mt-1 text-neutral-300">{item.text}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </ScrollReveal>

      {/* Under the hood */}
      <section className="border-t border-neutral-800 px-6 py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-3xl font-bold sm:text-4xl">Under the hood</h2>
          <p className="mt-6 text-neutral-400 leading-relaxed">
            Aura lives in Slack. Every message is embedded as a vector and
            stored -- when you talk to her, the most relevant memories surface by
            meaning, not keywords. A heartbeat runs every 30 minutes, processing
            scheduled jobs autonomously. She has access to your stack: BigQuery,
            Google Drive, GitHub, Gmail, calendar, browser, and a sandboxed Linux
            VM. She doesn&apos;t just answer questions about your data. She
            queries it, charts it, and tells you what it means.
          </p>
        </div>
      </section>

      {/* Real Numbers */}
      <ScrollReveal>
        <section className="border-t border-neutral-800 px-6 py-24">
          <div className="mx-auto max-w-4xl text-center">
            <h2 className="text-3xl font-bold sm:text-4xl">Real numbers</h2>
            <p className="mt-3 text-neutral-500">
              From her first 15 days inside a live company. Not a benchmark. Not a
              demo.
            </p>
            <div className="mt-12 grid grid-cols-2 gap-8 sm:grid-cols-4">
              {[
                {
                  stat: "88",
                  label: "PRs merged in 5 days",
                  context:
                    "More code shipped in a week than most teams ship in a month.",
                },
                {
                  stat: "2,300+",
                  label: "conversations held",
                  context:
                    "Across 20+ team members, 4 languages, every department.",
                },
                {
                  stat: "100+",
                  label: "knowledge notes",
                  context:
                    "Cross-referenced into a self-built knowledge graph.",
                },
                {
                  stat: "30+",
                  label: "autonomous jobs",
                  context:
                    "Running on schedule, without being asked. Bug sweeps, digests, follow-ups.",
                },
              ].map((item, i) => (
                <div
                  key={item.label}
                  className="reveal opacity-0 translate-y-4 transition-all duration-700 ease-out"
                  style={{ transitionDelay: `${i * 100}ms` }}
                >
                  <p className="text-4xl font-bold">{item.stat}</p>
                  <p className="mt-2 text-sm text-neutral-400">{item.label}</p>
                  <p className="mt-1 text-xs text-neutral-600">{item.context}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </ScrollReveal>

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
        <p className="mt-2 text-sm text-neutral-600">
          Free during beta. We&apos;ll set up a 15-minute demo to show you what
          she can do with your stack.
        </p>
        <WaitlistForm />
      </section>

    </main>
  );
}
