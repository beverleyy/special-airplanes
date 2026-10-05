class LiveryWatchError(Exception):
    """An error whose message is safe to show to the user."""


class FR24PausedError(LiveryWatchError):
    """Flightradar24 requests are paused after a rate limit or refusal."""

    def __init__(self, reason: str, until: float) -> None:
        from datetime import datetime
        self.until = until
        resume = datetime.fromtimestamp(until).strftime("%H:%M")
        super().__init__(f"{reason}, so Livery Watch has paused asking. Trying again at {resume}.")


class FR24FormatError(LiveryWatchError):
    """Flightradar24 answered, but not in the shape Livery Watch knows how to read."""

    def __init__(self, what: str) -> None:
        super().__init__(f"Flightradar24's data format has changed ({what}), so Livery Watch can't read it. "
                         "It needs an update.")
