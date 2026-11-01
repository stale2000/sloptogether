# SlopTogether

**A Twitch community makes the next scene in an ongoing AI video stream.**

Viewers suggest ideas and vote through the website, Twitch Extension, or chat. GPU workers turn selected ideas into video scenes, which are screened and reviewed before joining the stream. The broadcaster plays the program in a browser and captures it in OBS.

## How to use SlopTogether

- **Watch and participate:** Open a channel’s SlopTogether page or Twitch Extension. Submit a scene idea, then vote on what the community should see next. Chat votes count in the same election.
- **Run a channel:** Connect Twitch, set your channel’s contribution and review rules, and open its output page in OBS.
- **Contribute GPU time:** SlopTogether’s shared worker is designed to let streamers and viewers pool GPU capacity, including consumer GPUs.

## Why it’s different

SlopTogether is built around low-cost generation and shared compute. The project reports inference costs below $2 per hour on its optimized setup, aiming to make long-running AI video streams practical without relying on a large cloud GPU fleet. The app was built end to end with Codex.

## Project status

The goal is a continuously generated stream. Unattended 24/7 operation, public worker availability, and consumer GPU compatibility are still being qualified. Paid prompt features are not currently live.

## More information

- [Current project status](docs/architecture-plan.md)
- [Twitch Extension setup](extension/README.md)
- [GPU worker setup](workers/runtime/README.md)
- [Deployment guide](docs/deployment.md)

Watch the app at [clips.gg/sloptogether](https://www.clips.gg/sloptogether).
