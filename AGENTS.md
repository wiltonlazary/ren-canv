# ren-canv

Read the workspace layer first: `../../../AGENTS.md` and
`../../../.ai/config/` (stability.md first). Then [README.md](README.md) and
[TODO.md](TODO.md).

ren-canv is the engine of the drawn renderers (ren-skia, ren-three). It
consumes only ren-core's public entries (`ren-core`, `ren-core/host`). A change
here is finished once ren-dom, ren-skia, ren-three and rui-core pass too (the
root AGENTS.md's order). Its exports are
locked by `test/exports.lock.json`. Install rrx-core and ren-core first.
