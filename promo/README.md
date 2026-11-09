# Promo drafts (not published)

| file | where | angle |
|---|---|---|
| `devto.md` | Dev.to (front matter `published: false`) | practical tutorial, the fix in 5 steps |
| `hashnode.md` | Hashnode | long deep dive: data model, Lua, leases, 429 handling, tests |
| `medium.md` | Medium | short narrative, "the 429 that wasn't a rate limit" |
| `show-hn.md` | Hacker News | Show HN title and text |

Every number in these drafts comes from `npm run storm` (a local simulation, run three times with the same result) or from the linked public pages. Nothing here describes real users or production traffic.

Before posting: publish the npm package and the public repo first so every link resolves, then set `canonical_url` (Dev.to) / `canonical` (Hashnode) to the post chosen as the original.
