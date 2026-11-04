#!/usr/bin/env python3
"""ccs_tty.py — drive bin/ccs in a real pseudo-terminal and read the screen.

Test harness only (stdlib, no tmux / pyte): runs a command on a pty of a
fixed size, answers the cursor-position query fzf's renderer sends, feeds the
output through a small VT100 screen model, and follows a script of steps.

Usage:
    ccs_tty.py --cols 120 --rows 36 --script steps.json -- cmd arg...

steps.json is a list of objects, run in order:
    {"wait": "text", "timeout": 10}   wait until the screen contains text
    {"wait_gone": "text"}             wait until it no longer does
    {"send": "Studio"}                type text (escapes: "\\r" Enter,
                                      "\\u001b" Esc, "\\u001b[B" Down, ...)
    {"settle": 0.6}                   wait until the screen stops changing
    {"snap": "name"}                  record the screen under `name`
    {"exit": 10}                      wait (seconds) for the process to end

Prints one JSON object: {"snaps": {name: [lines]}, "exit": code|null,
"tail": [last screen lines], "error": str|null}. A failed wait is reported
in "error" with the screen at that moment, never as an exception.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import unicodedata


def char_width(ch: str) -> int:
    cp = ord(ch)
    if cp == 0:
        return 0
    if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):
        return 0
    if 0xFE00 <= cp <= 0xFE0F:  # variation selectors (fzf's runewidth: 0)
        return 0
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    return 1


class Screen:
    """Just enough of a VT100/xterm screen for fzf's renderers."""

    def __init__(self, cols: int, rows: int) -> None:
        self.cols, self.rows = cols, rows
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.top, self.bottom = 0, rows - 1
        self.saved = (0, 0)
        self.pending_wrap = False
        self.buf = ""
        self.replies: list[bytes] = []

    # -- helpers -----------------------------------------------------------
    def clamp(self) -> None:
        self.r = max(0, min(self.rows - 1, self.r))
        self.c = max(0, min(self.cols - 1, self.c))

    def scroll_up(self, n: int = 1) -> None:
        for _ in range(n):
            del self.grid[self.top]
            self.grid.insert(self.bottom, [" "] * self.cols)

    def scroll_down(self, n: int = 1) -> None:
        for _ in range(n):
            del self.grid[self.bottom]
            self.grid.insert(self.top, [" "] * self.cols)

    def linefeed(self) -> None:
        if self.r == self.bottom:
            self.scroll_up()
        else:
            self.r = min(self.rows - 1, self.r + 1)

    def put(self, ch: str) -> None:
        w = char_width(ch)
        if w == 0:
            return
        if self.pending_wrap:
            self.c = 0
            self.linefeed()
            self.pending_wrap = False
        if w == 2 and self.c == self.cols - 1:
            self.grid[self.r][self.c] = " "
            self.c = 0
            self.linefeed()
        self.grid[self.r][self.c] = ch
        if w == 2:
            self.grid[self.r][self.c + 1] = ""
        self.c += w
        if self.c >= self.cols:
            self.c = self.cols - 1
            self.pending_wrap = True

    # -- escape handling ---------------------------------------------------
    def csi(self, params: str, final: str) -> None:
        private = params.startswith("?") or params.startswith(">")
        raw = params.lstrip("?>")
        nums = [int(p) if p.isdigit() else 0 for p in raw.split(";")] if raw else []

        def n(i: int = 0, default: int = 1) -> int:
            v = nums[i] if i < len(nums) else 0
            return v if v else default

        self.pending_wrap = False
        if final == "A":
            self.r -= n()
        elif final == "B":
            self.r += n()
        elif final == "C":
            self.c += n()
        elif final == "D":
            self.c -= n()
        elif final == "E":
            self.r += n(); self.c = 0
        elif final == "F":
            self.r -= n(); self.c = 0
        elif final == "G":
            self.c = n() - 1
        elif final == "d":
            self.r = n() - 1
        elif final in ("H", "f"):
            self.r, self.c = n(0) - 1, n(1) - 1
        elif final == "J":
            mode = nums[0] if nums else 0
            if mode == 0:
                self.grid[self.r][self.c:] = [" "] * (self.cols - self.c)
                for rr in range(self.r + 1, self.rows):
                    self.grid[rr] = [" "] * self.cols
            elif mode == 1:
                for rr in range(0, self.r):
                    self.grid[rr] = [" "] * self.cols
                self.grid[self.r][: self.c + 1] = [" "] * (self.c + 1)
            else:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
        elif final == "K":
            mode = nums[0] if nums else 0
            row = self.grid[self.r]
            if mode == 0:
                row[self.c:] = [" "] * (self.cols - self.c)
            elif mode == 1:
                row[: self.c + 1] = [" "] * (self.c + 1)
            else:
                self.grid[self.r] = [" "] * self.cols
        elif final == "X":
            k = n()
            row = self.grid[self.r]
            for i in range(self.c, min(self.cols, self.c + k)):
                row[i] = " "
        elif final == "P":
            k = n()
            row = self.grid[self.r]
            del row[self.c : self.c + k]
            row.extend([" "] * (self.cols - len(row)))
        elif final == "@":
            k = n()
            row = self.grid[self.r]
            for _ in range(k):
                row.insert(self.c, " ")
            del row[self.cols :]
        elif final == "L":
            for _ in range(n()):
                del self.grid[self.bottom]
                self.grid.insert(self.r, [" "] * self.cols)
        elif final == "M":
            for _ in range(n()):
                del self.grid[self.r]
                self.grid.insert(self.bottom, [" "] * self.cols)
        elif final == "S":
            self.scroll_up(n())
        elif final == "T":
            self.scroll_down(n())
        elif final == "r" and not private:
            self.top = n(0) - 1
            self.bottom = (nums[1] if len(nums) > 1 and nums[1] else self.rows) - 1
            self.r, self.c = 0, 0
        elif final == "n" and not private and nums and nums[0] == 6:
            self.replies.append(f"\x1b[{self.r + 1};{self.c + 1}R".encode())
        elif final == "c" and not private:
            self.replies.append(b"\x1b[?1;2c")
        elif final == "s":
            self.saved = (self.r, self.c)
        elif final == "u":
            self.r, self.c = self.saved
        elif final in ("h", "l") and private and "1049" in raw.split(";"):
            self.grid = [[" "] * self.cols for _ in range(self.rows)]
        # m (SGR), t, q and other modes: no effect on the text
        self.clamp()

    def feed(self, data: str) -> None:
        s = self.buf + data
        self.buf = ""
        i = 0
        while i < len(s):
            ch = s[i]
            if ch == "\x1b":
                if i + 1 >= len(s):
                    self.buf = s[i:]
                    return
                nxt = s[i + 1]
                if nxt == "[":
                    j = i + 2
                    while j < len(s) and not ("\x40" <= s[j] <= "\x7e"):
                        j += 1
                    if j >= len(s):
                        self.buf = s[i:]
                        return
                    self.csi(s[i + 2 : j], s[j])
                    i = j + 1
                    continue
                if nxt == "]":  # OSC ... BEL or ST
                    j = i + 2
                    while j < len(s):
                        if s[j] == "\x07":
                            j += 1
                            break
                        if s[j] == "\x1b" and j + 1 < len(s) and s[j + 1] == "\\":
                            j += 2
                            break
                        j += 1
                    else:
                        self.buf = s[i:]
                        return
                    i = j
                    continue
                if nxt in "()*+":
                    i += 3
                    continue
                if nxt == "7":
                    self.saved = (self.r, self.c)
                elif nxt == "8":
                    self.r, self.c = self.saved
                elif nxt == "M":
                    if self.r == self.top:
                        self.scroll_down()
                    else:
                        self.r = max(0, self.r - 1)
                elif nxt == "D":
                    self.linefeed()
                elif nxt == "E":
                    self.c = 0
                    self.linefeed()
                i += 2
                continue
            if ch == "\r":
                self.c = 0
                self.pending_wrap = False
            elif ch == "\n":
                self.linefeed()
                self.pending_wrap = False
            elif ch == "\b":
                self.c = max(0, self.c - 1)
                self.pending_wrap = False
            elif ch == "\t":
                self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
            elif ch == "\x07" or ord(ch) < 0x20:
                pass
            else:
                self.put(ch)
            i += 1

    def lines(self) -> list[str]:
        return ["".join(row).rstrip() for row in self.grid]

    def text(self) -> str:
        return "\n".join(self.lines())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=36)
    ap.add_argument("--script", required=True)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
    steps = json.load(open(a.script, encoding="utf-8"))

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", a.rows, a.cols, 0, 0))
    os.kill(pid, signal.SIGWINCH)

    scr = Screen(a.cols, a.rows)
    decoder_buf = b""
    exit_code: int | None = None
    result: dict = {"snaps": {}, "exit": None, "tail": [], "error": None}

    def pump(timeout: float) -> bool:
        """Read what is available; False once the child closed the pty."""
        nonlocal decoder_buf
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            return True
        try:
            data = os.read(fd, 65536)
        except OSError:
            return False
        if not data:
            return False
        decoder_buf += data
        try:
            text = decoder_buf.decode("utf-8")
            decoder_buf = b""
        except UnicodeDecodeError as e:
            text = decoder_buf[: e.start].decode("utf-8", "replace")
            decoder_buf = decoder_buf[e.start :]
        scr.feed(text)
        for rep in scr.replies:
            os.write(fd, rep)
        scr.replies.clear()
        return True

    alive = True

    def wait_until(pred, timeout: float) -> bool:
        nonlocal alive
        end = time.time() + timeout
        while time.time() < end:
            if pred():
                return True
            if alive:
                alive = pump(0.05)
            else:
                time.sleep(0.05)
        return pred()

    try:
        for st in steps:
            if "wait" in st:
                t = st["wait"]
                if not wait_until(lambda: t in scr.text(), st.get("timeout", 15)):
                    result["error"] = f"timeout waiting for {t!r}"
                    break
            elif "wait_gone" in st:
                t = st["wait_gone"]
                if not wait_until(lambda: t not in scr.text(), st.get("timeout", 15)):
                    result["error"] = f"timeout waiting for {t!r} to go away"
                    break
            elif "send" in st:
                try:
                    os.write(fd, st["send"].encode("utf-8"))
                except OSError:
                    result["error"] = f"process gone before send {st['send']!r}"
                    break
            elif "settle" in st:
                quiet = st["settle"]
                end = time.time() + st.get("timeout", 15)
                last, since = scr.text(), time.time()
                while time.time() < end and alive:
                    alive = pump(0.05)
                    now = scr.text()
                    if now != last:
                        last, since = now, time.time()
                    elif time.time() - since >= quiet:
                        break
            elif "snap" in st:
                result["snaps"][st["snap"]] = scr.lines()
            elif "exit" in st:
                end = time.time() + st["exit"]
                while time.time() < end:
                    if alive:
                        alive = pump(0.05)
                    done, status = os.waitpid(pid, os.WNOHANG)
                    if done:
                        exit_code = os.waitstatus_to_exitcode(status)
                        break
                else:
                    result["error"] = "timeout waiting for exit"
                    break
        # drain what is left (bounded: a process still running after the
        # script — a failed wait, a missing "exit" step — is killed below)
        end = time.time() + 2.0
        while alive and time.time() < end:
            alive = pump(0.1)
            if exit_code is None:
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    exit_code = os.waitstatus_to_exitcode(status)
                    break
    finally:
        if exit_code is None:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except OSError:
                pass
        result["exit"] = exit_code
        result["tail"] = scr.lines()
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
