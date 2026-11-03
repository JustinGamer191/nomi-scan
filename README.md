# Nomi Scan

Snap up to 6 photos of your OTC meds (up to 5 products). Grok reads the boxes, openFDA supplies the label warnings, and plain code flags the
dangerous overlaps (like acetaminophen in both Tylenol and NyQuil).

**Not medical advice. Ask a pharmacist.**

## Setup (3 commands)

```bash
cd ~/Projects/nomi-scan
npm install
MOCK=1 npm run dev        # demo with no key; drop MOCK=1 once your key is in
```

Open http://localhost:3000. On a phone on the same Wi-Fi, use the Network URL that `next dev` prints.

## Add your xAI key

1. Create a key at https://console.x.ai
2. `cp .env.local.example .env.local` and paste it after `XAI_API_KEY=`
3. Restart `npm run dev`

Optional: `XAI_MODEL=...` overrides the model (default `grok-4.20-0309-non-reasoning`: about 6x faster than `grok-4.7` for label reading in testing).

Without a key the app still runs: a scan tells you how to add one, and the **Try demo** button always works (`?mock=1`).

## How it works

| Step | What | Where |
| --- | --- | --- |
| 1 | Grok vision reads each photo (parallel calls, one per image) into strict JSON `{products:[{brand, active_ingredients:[{name, strength}], confidence}], unreadable}`. If the JSON is bad, it retries once with a stricter prompt. Products seen in several photos (same brand + same ingredients) are merged. A box Grok can see but not read becomes a hint like "Image 2: labels too small to read, try a closer photo". | `lib/grok.ts`, `app/api/scan` |
| 2 | openFDA drug label per ingredient (`warnings`, `do_not_use`, `ask_doctor`, `stop_use`). A 404 shows "No label found". | `lib/fda.ts` |
| 3 | **Deterministic checks, no LLM**: the same ingredient in two products (red), plus a hardcoded list of OTC class pairs with sources (two NSAIDs = red; two sedating antihistamines or two decongestants = yellow). | `lib/checks.ts` |
| 4 | A second Grok call explains each flag using ONLY the label text we pass it, and cites the label. | `lib/grok.ts` |
| 5 | Recall check: live openFDA recall reports plus Grok web search (Responses API `web_search` tool) with source links. Without search it falls back to openFDA only. | `lib/recalls.ts` |
| 6 | Ask Nomi chat: answers only from the scanned products' label text, and otherwise sends you to a pharmacist. | `app/api/ask` |
| 7 | Dose timer: label directions (`dosage_and_administration`) parsed into min hours between doses and max per 24h. Grok extracts the numbers, and code checks that each number appears in the label text. Built-in rules are the fallback. The scheduling math is plain code. | `lib/dosing.ts`, `lib/schedule.ts` |

### Live mode

Tap **Live** at the top for a FaceTime-style scan. The camera (rear camera on phones) sends a downscaled frame (768px
max) to `/api/live-frame` every 2.5 seconds, but only when the previous frame has finished. Products build up in "Seen
so far", deduped like multi-photo. The same openFDA and deterministic checks rerun each time, and the status bar turns
red, yellow or green as you go.

- **Grok voice warnings:** when a new flag appears, Nomi speaks it with xAI's Grok text-to-speech (`/api/voice/tts`
  proxies `https://api.x.ai/v1/tts`, voice `eve`, so the key never reaches the browser). The sentence is built in code
  from the flag, 20 words or less ("Warning. Tylenol and NyQuil both contain acetaminophen..."). Grok only voices it.
  There's a Mute button.
- **Grok voice questions:** tap **Ask Nomi**, speak, and tap again. The clip goes to xAI speech-to-text
  (`/api/voice/stt` proxies `https://api.x.ai/v1/stt`), the question goes to `/api/ask` (grounded in the seen
  products' FDA labels), and the answer is spoken in Grok voice and shown as captions.
- **Honest fallback:** if an xAI voice call fails (or there's no key), Live mode falls back to the browser's
  `speechSynthesis` / `SpeechRecognition` automatically, and the badges on the video say **Voice: Grok** or
  **Voice: browser** (and the same for Mic). With no mic support, a text box appears instead. Set `XAI_VOICE` to pick
  another voice (`GET https://api.x.ai/v1/tts/voices` lists them, e.g. `ara`, `rex`).
- **Demo without camera:** simulates Tylenol at about 2.5s and NyQuil at about 5s, so the red warning fires about
  6 seconds in. It works with no camera and no key.

**Camera access needs localhost or HTTPS.** A phone opening `http://<laptop-ip>:3000` over the LAN will not get the
camera. Demo on the laptop itself, or tunnel with `ngrok http 3000` (use the https URL on the phone), or run
`npx next dev --experimental-https`. Voice recognition works best in Chrome.

API routes: `/api/scan` (main), `/api/live-frame`, `/api/voice/tts`, `/api/voice/stt`, `/api/recalls`, `/api/ask`, `/api/dosing`, `/api/schedule`. No database. Dose logs
stay in the browser's localStorage.

### MOCK mode

`MOCK=1` (env) or `?mock=1` returns canned Grok output for **Tylenol Extra Strength + Vicks NyQuil Cold & Flu**. The
openFDA calls stay live. Other scenarios: `?mock=nsaids` (Advil + Aleve, red), `?mock=green` (Tylenol + Claritin),
`?mock=nolabel` (unknown ingredient, yellow). Uploading 2+ photos in MOCK mode puts Tylenol in photo 1 and NyQuil + Tylenol
in photo 2 (to show the merge), and any photo after that returns the "labels too small" hint.

```bash
curl -s -X POST "localhost:3000/api/scan?mock=1" | jq '.status, .flags[].title'
# "red"
# "Duplicate ingredient: acetaminophen"
```

## Demo script (about 2 minutes)

1. **Hook.** "Tylenol and NyQuil are on every dorm shelf. Most people don't know they both contain acetaminophen."
2. **Scan.** Hold up a real Tylenol Extra Strength box and a NyQuil Cold & Flu box. Take one photo of both on your phone
   with **Take photo** (or one photo each with **Take another photo**), or drop the photos on the laptop, then tap
   **Scan**. (If the wifi or the key fails, tap
   **Try demo**.)
3. **Red warning.** The banner turns red: "Duplicate ingredient: acetaminophen". Read the explanation out loud. It
   quotes the FDA label ("Severe liver damage may occur if you take more than 4,000 mg...") and cites which label it
   came from.
4. **Med cards.** Point at the acetaminophen rows highlighted in both cards, then the recall badge. Expand it to show
   the live FDA recall notices with source links (Grok web search adds alerts when the key is on).
5. **Ask Nomi.** Tap "Can I drink alcohol with these?" and it answers from the label. Then ask something off-label
   ("what's the best antibiotic?"). It declines and says to ask a pharmacist.
6. **Live mode (optional wow moment).** Switch to **Live**, tap **Start camera**, and hold up Tylenol, then NyQuil.
   The bar flips red and Nomi says the warning out loud. Tap **Ask Nomi** and say "Can I drink alcohol with these?"
   (No camera or network? Use **Demo without camera**.)
7. **Dose timer.** Log "took Tylenol at 8:00". The acetaminophen bar drops to 3,000 mg left and NyQuil shows its next
   safe time. Paste a schedule (`1:00-2:15pm CS 2110`, `5pm-6:30pm gym`) or upload a .ics, and the green dots move out
   of class: "Take after CS 2110". Close on "Follow the label; ask a pharmacist."

## 60-second pitch

> Acetaminophen overdose is the leading cause of acute liver failure in the US, and much of it is accidental: people
> take Tylenol for a headache and NyQuil for a cold without realizing both contain the same drug. The warning is on
> the box, in tiny type, on the back.
>
> Nomi Scan turns that into one photo. Grok's vision model reads every box in the shot. We pull the official FDA
> label for each ingredient from openFDA. Then the safety check is plain, deterministic code, not an LLM guessing:
> same ingredient twice, two NSAIDs, stacked sedating antihistamines. Grok does what LLMs are good at. It reads messy
> packaging, explains the warning in plain English grounded only in the FDA text with a citation, searches the live
> web for recalls, and turns label directions into a dose timer that plans around your class schedule.
>
> No account, no database, works on your phone in the pharmacy aisle. It's not medical advice. It's the nudge to ask
> the pharmacist before you double up.

## Safety notes

- The LLM never decides whether something is dangerous. `lib/checks.ts` does.
- Explanations and chat answers are grounded in openFDA text fetched on the server, not text sent by the client.
- Dose numbers parsed by Grok are rejected unless they literally appear in the label directions.
- The UI always shows: "Not medical advice. Ask a pharmacist."
