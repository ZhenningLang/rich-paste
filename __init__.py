"""rich-paste: agent half (llm_request middleware) of the unified package."""

try:  # loaded by Hermes as a package
    from . import interleave
except ImportError:  # imported as a top-level module (tests, scripts)
    import interleave  # type: ignore[no-redef]


def register(ctx):
    ctx.register_middleware("llm_request", interleave.on_llm_request)
