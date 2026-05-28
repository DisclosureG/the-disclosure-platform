import { buildScenes, type VideoConfig } from "../types";
import { c, tier } from "../theme";
import voiceover from "./tour.voiceover.json";

// "Tour" — a warm, joyful 2:56 walkthrough of the Disclosure Platform, rebuilt
// in the light "Daylight" system. Scene ids + durations come from the voiceover
// manifest (baked from per-line ElevenLabs takes); the visuals below are the
// foreground for each beat.
const FPS = 30;

export const TOUR: VideoConfig = {
  id: "Tour",
  fps: FPS,
  width: 1920,
  height: 1080,
  voPath: voiceover.voPath,
  scenes: buildScenes(voiceover, FPS, {
    open: {
      kind: "title",
      props: {
        brand: true,
        kicker: "A record, kept by many",
        headline: "Some things matter\n*too much to forget.*",
        subhead:
          "The Disclosure Platform — a public record for the world's most contested ideas. Owned by no one.",
        headlineSize: 94,
      },
    },

    method: {
      kind: "steps",
      props: {
        kicker: "How it works",
        headline: "Science, *out in the open.*",
        items: [
          { ordinal: "STEP 01", title: "File a claim", sub: "With its source attached.", icon: "file", color: c.sky, soft: c.skySoft },
          { ordinal: "STEP 02", title: "Open review", sub: "Real people weigh in — free to disagree.", icon: "users", color: c.coralDeep, soft: c.coralSoft },
          { ordinal: "STEP 03", title: "It earns its place", sub: "Kept only while it holds up.", icon: "shieldCheck", color: c.good, soft: c.sageSoft },
          { ordinal: "STEP 04", title: "Back in public hands", sub: "Every step belongs to everyone.", icon: "heart", color: "#B8801F", soft: c.butterSoft },
        ],
      },
    },

    taxonomy: {
      kind: "taxonomy",
      props: {
        kicker: "The archive grows itself",
        headline: "Wider, deeper — and honest enough to *shrink.*",
        caption: "The map keeps pace with what we actually know.",
        pillars: [
          {
            name: "Non-Human Intelligence",
            color: c.sky,
            soft: c.skySoft,
            icon: "globe",
            topics: [
              { name: "Crash Retrieval" },
              { name: "Recovered Biologics" },
              { name: "Government Records" },
              { name: "Paranormal", state: "retire" },
            ],
          },
          {
            name: "Psychic Abilities",
            color: c.lilac,
            soft: c.lilacSoft,
            icon: "star",
            topics: [
              { name: "Telepathy" },
              { name: "Out-of-Body" },
              { name: "Precognition" },
              { name: "Remote Viewing", state: "new" },
            ],
          },
        ],
      },
    },

    tiers: {
      kind: "tiers",
      props: {
        kicker: "Honest about its strength",
        headline: "Every entry, filed in *three tiers.*",
        callout: "A tier describes the evidence — not whether it's true.",
        items: [
          { roman: tier[1].roman, title: "Peer-reviewed & declassified", sub: "The strongest evidence we accept.", color: tier[1].ink, soft: tier[1].soft, strength: 3, at: 6.0 },
          { roman: tier[2].roman, title: "Documented sources", sub: "Books, records, institutional files.", color: tier[2].ink, soft: tier[2].soft, strength: 2, at: 9.3 },
          { roman: tier[3].roman, title: "First-hand testimony", sub: "Sworn, named, personal accounts.", color: tier[3].ink, soft: tier[3].soft, strength: 1, at: 12.4 },
        ],
      },
    },

    lifecycle: {
      kind: "lifecycle",
      props: {
        kicker: "Every entry's little journey",
        headline: "It travels from *queue* to *record.*",
        stations: [
          { label: "Queued", icon: "plus", color: c.sky, soft: c.skySoft },
          { label: "In review", icon: "eye", color: "#B8801F", soft: c.butterSoft },
          { label: "In the record", icon: "bookOpen", color: c.good, soft: c.sageSoft },
        ],
        branchTryAgain: "Didn't make it? It steps aside — and can always try again.",
        branchRevisit: "Even settled records stay open. Anything can be revisited.",
      },
    },

    voting: {
      kind: "voting",
      props: {
        kicker: "Signed, with a reason",
        headline: "Every vote is *signed* — and carries a note.",
        peerHandle: "aerial-phenomena.eth",
        peerAddr: "0x0a1c…3aae",
        peerInitials: "AP",
        tierLabel: "Tier II · Documented",
        verdict: "Approves this record",
        note: "Matthew Brown's credentials check out — I trust this source.",
        footer: "recovered on-chain from the signer's own wallet",
      },
    },

    "canon-not-proof": {
      kind: "title",
      props: {
        icon: "scale",
        kicker: "Evidence, not proof",
        headline: "In the record isn't\nthe same as *true.*",
        subhead:
          "It means the people who study this stand behind it — for now. The question stays open. And that's the point.",
        headlineSize: 84,
      },
    },

    peers: {
      kind: "peer-grid",
      props: {
        kicker: "No gatekeepers",
        headline: "*Peers* verify peers.",
        caption: "Invited, endorsed, verified — the community looks after itself.",
        threshold: 4,
        nominee: { initials: "JD", color: c.coralDeep, soft: c.coralSoft },
        members: [
          { initials: "MK", color: c.sky, soft: c.skySoft },
          { initials: "AL", color: c.good, soft: c.sageSoft },
          { initials: "RV", color: "#B8801F", soft: c.butterSoft },
          { initials: "JL", color: c.lilac, soft: c.lilacSoft },
          { initials: "EC", color: c.coralDeep, soft: c.blushSoft },
          { initials: "SN", color: c.sky, soft: c.skySoft },
          { initials: "DK", color: c.good, soft: c.sageSoft },
          { initials: "HM", color: "#B8801F", soft: c.butterSoft, leaving: true },
          { initials: "PR", color: c.lilac, soft: c.lilacSoft },
          { initials: "BW", color: c.coralDeep, soft: c.blushSoft },
        ],
      },
    },

    capture: {
      kind: "walls",
      props: {
        kicker: "Built to outlast pressure",
        headline: "Three ways projects die — *designed out.*",
        items: [
          { icon: "globe", problem: "The host gets pressured", solutionIcon: "shield", solution: "The blockchain is the host" },
          { icon: "users", problem: "The moderators get bought", solutionIcon: "pen", solution: "Signatures are the moderators" },
          { icon: "coin", problem: "The funding dries up", solutionIcon: "heart", solution: "Everyone covers their own gas" },
        ],
      },
    },

    refusals: {
      kind: "refusals",
      props: {
        kicker: "By design",
        headline: "What we *left out* — on purpose.",
        banner: "Left out, on purpose.",
        items: [
          { icon: "heart", label: "No likes" },
          { icon: "note", label: "No endless feed" },
          { icon: "coin", label: "No ads, nothing for sale" },
          { icon: "eye", label: "No tracking" },
          { icon: "users", label: "No anonymous moderators" },
          { icon: "lockOpen", label: "No owner, no kill-switch" },
        ],
      },
    },

    map: {
      kind: "title",
      props: {
        icon: "compass",
        iconColor: "#3F7CA1",
        iconBg: c.skySoft,
        kicker: "A map, not a monument",
        headline: "Not a monument.\nA living *map.*",
        subhead:
          "A monument freezes the truth. A map keeps growing — and expects to be corrected.",
        headlineSize: 90,
      },
    },

    cta: {
      kind: "cta",
      props: {
        headline: "The record is open.\n*There's a seat for you.*",
        actions: [
          { icon: "bookOpen", label: "Read it", color: c.sky, soft: c.skySoft },
          { icon: "plus", label: "Add evidence", color: c.coralDeep, soft: c.coralSoft },
          { icon: "star", label: "Earn your place", color: "#B8801F", soft: c.butterSoft },
          { icon: "heart", label: "Keep it honest", color: c.good, soft: c.sageSoft },
        ],
        url: "thedisclosureplatform.com",
      },
    },
  }),
};
