# Promo drafts (not published)

| file | where | angle |
|---|---|---|
| `devto.md` | Dev.to (front matter `published: false`) | practical tutorial, the fix in 5 steps |
| `hashnode.md` | Hashnode | long deep dive: data model, Lua, leases, 429 handling, tests |
| `medium.md` | Medium | short narrative, "the 429 that wasn't a rate limit" |
| `show-hn.md` | Hacker News | Show HN title and text |

Every number in these drafts comes from `npm run storm` (a local simulation, run three times with the same result) or from the linked public pages. Nothing here describes real users or production traffic.

Order: post Dev.to first (it is the canonical original), then set Hashnode `canonical` and the Medium canonical link to that Dev.to URL. The npm release is still pending, so every install line points at the v0.1.0 GitHub release.
