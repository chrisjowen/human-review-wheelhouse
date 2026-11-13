# human-review-wheelhouse

A [Wheelhouse](https://github.com/chrisjowen/wheelhouse) plugin that uses
[Human Review](https://github.com/petergyang/human-review) as your review surface. You edit
and comment on a worker's live preview, or a task's HTML or Markdown page, directly in Human
Review, and your changes go back to that task's worker.

- **Edit with Human Review** on every live preview (the chat's preview boxes and a task's Live
  preview tab). It opens Human Review in a new tab. While this plugin is your review surface,
  it is the preview's primary button.
- A **Human Review** section on each task that has something to review. It lists the task's
  preview and pages with their review state: review open, a worker listening, feedback waiting,
  or feedback in the worker's hands. It has **Edit with Human Review** for each page and **Send to
  the worker** for feedback that is waiting.
- A companion service, the **bridge**, on this computer only. It installs and starts Human
  Review's server when needed and opens review sessions.
- It provides the `review.surface` role. When you choose it in **Settings → Plugins**, Wheelhouse
  hides its own preview helper and board links, and tells Firstmate and its workers to use Human
  Review instead of Lavish.

Shared review stays the remote, multi-person layer: use it to have other people comment, or to
review from a phone. Human Review is for you, on the computer that runs Wheelhouse.

## Install

```sh
wheelhouse plugin install chrisjowen/human-review-wheelhouse@v0.1.0
```

You can also use **Install** on the **Plugins** page in Wheelhouse. The plugin is off until you
turn it on in **Settings → Plugins**. To make it your review surface, choose **Human Review** as
the review surface on that page. Turning it off, or choosing the built-in again, brings back
Lavish and the preview helper.

It needs Node 20 or later and `npm` on the `PATH`. The first time Wheelhouse launches the bridge,
it installs Human Review (from npm, at the version in the plugin's settings) into the plugin's
state folder.

## How it works

1. You click **Edit with Human Review** on a preview, or on a page in the task's section. A new
   tab opens on the bridge, which opens a Human Review session for that page and sends the tab
   there. If the bridge is not running yet, Wheelhouse launches it first, which can take a few
   seconds the first time while Human Review installs.
2. You edit the text directly, comment on what you select, and click **Send** in Human Review.
3. If the task's worker is already listening (its `human-review poll` is running), the worker gets
   the batch at once. Otherwise Human Review keeps it, and shows "Sent — agent is not listening".
   The task's Human Review section and the preview then show **Send to the worker**.
4. **Send to the worker** sends Firstmate one feedback list about the task, on your click, through
   Wheelhouse's `feedback` capability. Firstmate passes it to the worker of the task the review
   was opened for. Send needs the bridge running, because the bridge notes the forward so the same
   batch is never offered twice; **Edit with Human Review** starts it. The list gives
   the gist (one line per comment and edit) and starts with the exact command that hands the
   worker the full batch:

   ```sh
   npx -y human-review@0.8.2 poll http://localhost:5173/pricing
   ```

5. The worker applies the batch and runs the same command with `--ack` in the background. That
   clears the batch and, while your Human Review tab is open, waits for your next Send. From then
   on your Sends reach the worker directly, with no button to click.

The plugin itself only reads. Its providers run `bridge/main.mjs status --json`, which reads Human
Review's files (`~/.human-review`) and asks its server. Only the bridge opens sessions, and only
when you click.

## What I found trying Human Review (0.8.2)

- **Embedding:** Human Review's review page sends no `X-Frame-Options` or `frame-ancestors`, and it
  frames from another origin. It also reviews an app that forbids framing itself, because it
  proxies the app. But it only works where the browser is on this computer. Its server listens on
  `127.0.0.1` and refuses any other `Host`, and the reviewed page runs on the other loopback name.
  A review also ends when its tab goes away, which a section that unmounts would cause. So the
  plugin **opens Human Review in its own tab** rather than embedding it.
- **Phones:** these do not work. The server cannot be reached from another device, even through a
  forward, and Human Review has no small-screen layout. When Wheelhouse is opened from elsewhere
  (a phone, Wheelhouse Cloud, a hosted environment), the button says so and points at Shared
  review.
- **`poll` after you started the session:** feedback you send with nobody polling is saved. A later
  `human-review poll <target>` returns the full batch at once, even after the tab has closed, and
  it stays until `poll --ack`. A poll for a page with no review open gives up after 10 seconds
  (`{"status":"closed","reason":"no_review_open"}`). A review the CLI opens with no browser
  connecting ends after 60 seconds. This is why reviews start from Wheelhouse, and why workers
  poll only once feedback is waiting or a review is open.

## For Firstmate and workers

While Wheelhouse names Human Review as the review surface, use it instead of Lavish for anything
you show the captain:

- **A running app:** report its preview as usual (`preview <url>`, a `localhost` or `127.0.0.1`
  address). The captain opens it with **Edit with Human Review**. Their feedback arrives as a
  note about your task.
- **An HTML or Markdown page** (a plan, a report, a design): write it in the task's worktree and
  serve it on a `localhost` address reported as the task's preview, so the captain opens it with
  **Edit with Human Review**. Files in the task's worktree that Human Review has reviewed also show
  in the task's Human Review section.

- **When the note arrives:** run the command it names, `npx -y human-review@<version> poll
<target>`, from your worktree. It prints the batch as JSON. Apply it as its `next_step` and
  Human Review's own rules say: `edits` are the captain's exact wording, so carry them over
  verbatim and never revert them. Then run the same command with `--ack`, in the background,
  to receive the captain's next Send. Stop when it prints `{"status":"closed"}`.
- Do not open reviews yourself with `npx human-review <target>`. That opens a browser on this
  computer, and the session ends after 60 seconds when no tab connects.
- To check a task's reviews: `node …/bridge/main.mjs status --task <task-id>`. (The section's
  **For Firstmate and workers** fold shows the exact path to `main.mjs`; it is under
  `$WHEELHOUSE_PLUGINS_DIR` when that is set.)

## Settings

| Setting                              | Default | What it is                                                                                                    |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------- |
| `version` (**Human Review version**) | `0.8.2` | The `human-review` npm version the bridge installs and runs, and the version the worker's poll command names. |

## Security

- The bridge listens on `127.0.0.1` only and refuses requests whose `Host` is not this computer's
  loopback. Wheelhouse starts it only when you click.
- Opening a review needs the plugin's key, a random secret kept in the plugin's state folder
  (mode 0600) and handed to Wheelhouse's page by the provider. Other web pages cannot open
  reviews through the bridge. The key travels in the address of the tab that opens a review,
  which stays on this computer.
- Human Review's own token stays in its `server.json`. The plugin reads it to ask the server, and
  never prints or returns it.
- Sending feedback is always your click, through Wheelhouse, which writes the message to Firstmate.
- As with every installed plugin, its code runs with your permissions: install it at a commit you
  have looked at.

## Limits

- Human Review reviews pages on this computer only: `localhost`, `127.0.0.1` and `[::1]` addresses,
  and local files. A preview on another host, or a remote second mate's preview, cannot be opened.
- The worker must be on this computer to take the full batch with `poll`. A worker elsewhere still
  gets the gist in Firstmate's note.
- One Human Review server serves the computer (`~/.human-review`). A worker's newer
  `npx human-review` replaces an older server. Saved feedback survives, because it is kept on
  disk.
- The plugin does not retire Wheelhouse's preview helper; it is hidden only while this plugin is
  your review surface.

## Development

```sh
npm ci
npm run lint
npm test
```

The tests run the bridge against the real `human-review` package in throwaway folders, and the
elements in happy-dom.

## License

MIT. [Human Review](https://github.com/petergyang/human-review) is Peter Yang's, also MIT; this
plugin installs it from npm and does not include it.
