#!/usr/bin/env python3
"""Correlated BG3 label hover bridge. JSON lines in, JSON lines out.

The runner owns BG3. This process owns only a temporary relative pointer and
never emits a button or key. Closing, losing authorization or losing focus
closes the device without attempting to move the desktop cursor.
"""

import csv
import ctypes
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time


# Prefix of the OCR label the client renders over the target. Must match pointer.ts and HarnessTargetLabel.lua.
LABEL_PREFIX = "HNX"
OPERATIONS = {"preview-target", "cast-target", "cast-selected-target", "inspect-target-validation"}
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}\Z")
SPELL_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,199}\Z")
UUID_PATTERN = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
LABEL_ALPHABET = "ABCDEFGHJKLMNPQR"
MAX_JSON_BYTES = 131072
MAX_TSV_BYTES = 2097152
MAX_CAPTURE_ATTEMPTS = 8
REQUEST_KEYS = {
    "schemaVersion", "runId", "scenarioId", "stepId", "sequence", "operation",
    "casterUuid", "targetUuid", "spellId", "castGuid", "phase", "targetLabel",
    "observedAtEpochMs", "expiresAtEpochMs", "viewport", "entries",
}


class PointerError(RuntimeError):
    pass


class LabelNotFound(PointerError):
    pass


def integer(value, minimum=0, maximum=2 ** 53 - 1):
    return type(value) is int and minimum <= value <= maximum


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def target_label(target_uuid):
    if not isinstance(target_uuid, str) or not UUID_PATTERN.fullmatch(target_uuid):
        raise PointerError("Target UUID must be canonical lowercase text")
    return LABEL_PREFIX + "".join(LABEL_ALPHABET[int(char, 16)] for char in target_uuid[:8])


def parse_policy(raw):
    """The runner passes the scenario's pointer policy once, at spawn."""
    try:
        policy = json.loads(raw)
    except ValueError:
        raise PointerError("Pointer policy is not JSON") from None
    if (not isinstance(policy, dict)
            or set(policy) != {"scenarioId", "saveId", "operation", "spellId", "steps"}
            or not isinstance(policy["scenarioId"], str) or not IDENTIFIER_PATTERN.fullmatch(policy["scenarioId"])
            or not isinstance(policy["saveId"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", policy["saveId"])
            or policy["saveId"] == "__new_campaign__"
            or policy["operation"] not in OPERATIONS
            or not isinstance(policy["spellId"], str) or not SPELL_PATTERN.fullmatch(policy["spellId"])
            or not isinstance(policy["steps"], list) or not 1 <= len(policy["steps"]) <= 8
            or len(set(policy["steps"])) != len(policy["steps"])
            or not all(isinstance(step, str) and IDENTIFIER_PATTERN.fullmatch(step) for step in policy["steps"])):
        raise PointerError("Pointer policy is invalid")
    return policy


def parse_tsv(raw, label, viewport):
    """Return one exact, confident word. Ambiguous tokens never cause movement."""
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_TSV_BYTES:
        raise PointerError("OCR output exceeds its size limit")
    if not isinstance(label, str) or not label or "\t" in label or "\n" in label:
        raise PointerError("Invalid OCR target label")
    if not isinstance(viewport, list) or len(viewport) != 2 or not all(
        integer(value, 1, 16384) for value in viewport
    ):
        raise PointerError("Invalid OCR viewport")
    reader = csv.DictReader(io.StringIO(raw), delimiter="\t")
    required = {"level", "left", "top", "width", "height", "conf", "text"}
    if not reader.fieldnames or not required.issubset(reader.fieldnames):
        raise PointerError("OCR TSV is missing required columns")
    candidates = []
    for row in reader:
        if row.get("level") != "5" or row.get("text") not in (label, label + "*"):
            continue
        try:
            box = [int(row[key]) for key in ("left", "top", "width", "height")]
            confidence = float(row["conf"])
        except (TypeError, ValueError):
            raise PointerError("OCR target has malformed coordinates or confidence") from None
        x, y, width, height = box
        if (not math.isfinite(confidence) or not 0 <= confidence <= 100
                or x < 0 or y < 0 or width <= 0 or height <= 0
                or x + width > viewport[0] or y + height > viewport[1]):
            raise PointerError("OCR target has an invalid bounding box or confidence")
        candidates.append({"text": row["text"], "confidence": confidence, "box": box})
    if len(candidates) > 1:
        raise PointerError("OCR target label is ambiguous")
    if not candidates or candidates[0]["confidence"] < 70:
        raise LabelNotFound("OCR target label is absent or below confidence 70")
    return candidates[0]


def read_json(path):
    """Reject symlinks, partial JSON and oversized authorization artifacts."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_JSON_BYTES:
                raise PointerError("Harness artifact is not a bounded regular file")
            raw = stream.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise PointerError("Harness artifact exceeds its size limit")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise PointerError("Harness artifact must be an object")
        return value
    except (OSError, ValueError) as error:
        raise PointerError("Harness authorization artifact is unavailable or invalid") from error


def process_start_time(raw, pid):
    prefix, separator, suffix = raw.rpartition(") ")
    fields = suffix.split()
    if (not separator or not prefix.startswith(str(pid) + " (") or len(fields) <= 19
            or fields[0] in ("Z", "X", "x") or not re.fullmatch(r"[1-9][0-9]*", fields[19])):
        raise PointerError("Owned process stat is invalid or terminal")
    return fields[19]


def validate_process(pid, start_time, save_id, policy, proc_root=Path("/proc")):
    if save_id != policy["saveId"] or not integer(pid, 1) or not re.fullmatch(r"[1-9][0-9]*", start_time):
        raise PointerError("Invalid BG3 process ownership")
    try:
        directory = proc_root / str(pid)
        actual_start = process_start_time((directory / "stat").read_text(), pid)
        arguments = (directory / "cmdline").read_bytes().decode("utf-8").split("\0")
    except (OSError, ValueError) as error:
        raise PointerError("Owned BG3 process disappeared") from error
    if actual_start != start_time:
        raise PointerError("Owned BG3 PID was reused")
    if any(arg.lower().startswith("-continuegame") for arg in arguments):
        raise PointerError("Continue-game launches are forbidden")
    if arguments.count("-loadSaveGame") != 1:
        raise PointerError("Owned BG3 process lacks one exact save launch")
    index = arguments.index("-loadSaveGame")
    if index + 1 >= len(arguments) or arguments[index + 1] != save_id:
        raise PointerError("Owned BG3 process targets another save")
    if any(arg.lower().startswith("-loadsavegame") and arg != "-loadSaveGame"
           for arg in arguments):
        raise PointerError("Owned BG3 process has an ambiguous save launch")


def validate_window(window, monitors, pid, viewport):
    if (not isinstance(window, dict) or window.get("pid") != pid
            or window.get("class") != "steam_app_1086940" or window.get("mapped") is not True
            or window.get("hidden") is True
            or not isinstance(window.get("stableId"), str)
            or not re.fullmatch(r"[0-9a-f]+", window["stableId"], re.IGNORECASE)
            or not isinstance(window.get("address"), str)
            or not re.fullmatch(r"0x[0-9a-f]+", window["address"], re.IGNORECASE)):
        observed = {key: window.get(key) for key in (
            "pid", "class", "mapped", "hidden", "stableId", "address", "monitor"
        )} if isinstance(window, dict) else {"valueType": type(window).__name__}
        raise PointerError("Focused window is not the owned mapped BG3 window: "
                           + json.dumps({"expectedPid": pid, "observed": observed}, sort_keys=True))
    position = window.get("at")
    if (not isinstance(position, list) or len(position) != 2
            or not all(integer(value, -100000, 100000) for value in position)
            or window.get("size") != viewport):
        raise PointerError("BG3 geometry does not match the client viewport")
    matches = [monitor for monitor in monitors if isinstance(monitor, dict)
               and monitor.get("id") == window.get("monitor")]
    if len(matches) != 1:
        raise PointerError("BG3 monitor identity is ambiguous")
    monitor = matches[0]
    if (monitor.get("scale") != 1 or monitor.get("transform") != 0
            or monitor.get("focused") is not True or monitor.get("disabled") is True
            or monitor.get("dpmsStatus") is False
            or monitor.get("mirrorOf") not in (None, "none", "")):
        raise PointerError("Pointer capture requires an untransformed monitor at scale 1")
    if not all(integer(monitor.get(key), -100000, 100000) for key in ("x", "y")) or not all(
        integer(monitor.get(key), 1, 16384) for key in ("width", "height")
    ):
        raise PointerError("BG3 monitor has invalid dimensions")
    workspace = window.get("workspace")
    active_workspace = monitor.get("activeWorkspace")
    if (not isinstance(workspace, dict) or not isinstance(active_workspace, dict)
            or not integer(workspace.get("id"), 1)
            or workspace.get("id") != active_workspace.get("id")):
        raise PointerError("BG3 workspace is not active on its monitor")
    x, y = position
    if (x < monitor["x"] or y < monitor["y"]
            or x + viewport[0] > monitor["x"] + monitor["width"]
            or y + viewport[1] > monitor["y"] + monitor["height"]):
        raise PointerError("BG3 viewport crosses its monitor boundary")
    return {
        "pid": pid, "stableId": window["stableId"], "address": window["address"],
        "at": position, "size": viewport, "workspaceId": workspace["id"],
        "monitor": {key: monitor[key] for key in (
            "id", "x", "y", "width", "height", "scale", "transform",
        )},
    }


def validate_envelope(message, now_ms, policy):
    if not isinstance(message, dict) or not isinstance(message.get("id"), str) or not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._:-]{0,99}", message["id"]
    ):
        raise PointerError("Pointer command needs a bounded correlation id")
    if message.get("action") == "close":
        return None
    if set(message) != {"id", "action", "pid", "startTimeTicks", "saveId", "runDirectory", "request"}:
        raise PointerError("Pointer command has unsupported fields")
    request = message["request"]
    if (not isinstance(request, dict) or not REQUEST_KEYS.issubset(request)
            or set(request) - REQUEST_KEYS - {"projection"} or request.get("schemaVersion") != 2):
        raise PointerError("Pointer request has unsupported fields or schema")
    phase = message["action"]
    if phase not in ("hover", "leave") or request["phase"] != phase:
        raise PointerError("Pointer phase does not match its action")
    if (request["scenarioId"] != policy["scenarioId"] or request["operation"] != policy["operation"]
            or request["spellId"] != policy["spellId"]):
        raise PointerError("Pointer scenario, operation or spell is not allowed")
    steps = policy["steps"]
    if (not integer(request["sequence"], 1, len(steps)) or request["stepId"] != steps[request["sequence"] - 1]
            or request["casterUuid"] == request["targetUuid"]):
        raise PointerError("Pointer request does not match its authorized step")
    run_id = request["runId"]
    if not isinstance(run_id, str) or not run_id.startswith("run-") or not UUID_PATTERN.fullmatch(run_id[4:]):
        raise PointerError("Pointer run id is invalid")
    for key in ("casterUuid", "targetUuid", "castGuid"):
        value = request[key]
        if not isinstance(value, str) or not UUID_PATTERN.fullmatch(value) or value == "00000000-0000-0000-0000-000000000000":
            raise PointerError("Pointer request has an invalid entity or cast UUID")
    if (not isinstance(request["stepId"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", request["stepId"])
            or not integer(request["sequence"], 1)
            or request["targetLabel"] != target_label(request["targetUuid"])):
        raise PointerError("Pointer step or target label does not match its target")
    entries = request["entries"]
    if (not isinstance(entries, list) or not 1 <= len(entries) <= 256
            or any(not isinstance(entry, dict) for entry in entries)):
        raise PointerError("Pointer target labels are invalid")
    matches = [entry for entry in entries if entry.get("uuid") == request["targetUuid"]]
    if len(matches) != 1 or matches[0].get("objectType") != "ls.Character":
        raise PointerError("Pointer request lacks its unique character label")
    if "projection" in request and not isinstance(request["projection"], dict):
        raise PointerError("Pointer projection diagnostic is invalid")
    if (not integer(request["observedAtEpochMs"]) or not integer(request["expiresAtEpochMs"])
            or not 0 <= now_ms - request["observedAtEpochMs"] <= 2000
            or not now_ms < request["expiresAtEpochMs"]):
        raise PointerError("Pointer request is expired, future dated or stale")
    viewport = request["viewport"]
    if not isinstance(viewport, list) or len(viewport) != 2 or not all(integer(value, 1, 16384) for value in viewport):
        raise PointerError("Pointer viewport is invalid")
    if (not integer(message["pid"], 1) or not isinstance(message["startTimeTicks"], str)
            or not re.fullmatch(r"[1-9][0-9]*", message["startTimeTicks"])
            or message["saveId"] != policy["saveId"]):
        raise PointerError("Pointer process ownership or fixture is invalid")
    directory = message["runDirectory"]
    if not isinstance(directory, str):
        raise PointerError("Pointer run directory is invalid")
    path = Path(directory)
    if (not path.is_absolute() or path.name != run_id or path.parent.name != "runs"
            or path.parent.parent.name != "TestHarness" or not path.is_dir()
            or str(path.resolve()) != directory):
        raise PointerError("Pointer run directory is not the canonical harness run path")
    return request


class PointerBridge:
    def __init__(self, policy):
        self.policy = policy
        self.device = None
        self.ecodes = None
        self.parent_pid = os.getppid()
        self.owner = None
        self.window = None
        self.authorization = None
        self.before_cursor = None
        self.last_owned_cursor = None
        self.hover_request = None
        self.completed_phases = set()
        self.failed = False
        self.closed = False
        self.movements = []

    def now_ms(self):
        return time.time_ns() // 1000000

    def hypr(self, query):
        try:
            result = subprocess.run(["hyprctl", query, "-j"], check=True, capture_output=True,
                                    text=True, timeout=2)
            return json.loads(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise PointerError("Hyprland state is unavailable") from error

    def cursor(self):
        value = self.hypr("cursorpos")
        if not isinstance(value, dict) or set(value) != {"x", "y"} or not all(
            finite_number(value[key]) and abs(value[key]) <= 100000 for key in ("x", "y")
        ):
            raise PointerError("Hyprland cursor position is invalid")
        return value

    def authorize(self, message):
        if os.getppid() != self.parent_pid or self.parent_pid == 1:
            raise PointerError("Pointer runner disappeared")
        request = message["request"]
        directory = Path(message["runDirectory"])
        if str(directory.resolve()) != message["runDirectory"]:
            raise PointerError("Harness run directory identity changed")
        for artifact in ("result.json", "server-finalizing.json"):
            if os.path.lexists(directory / artifact):
                raise PointerError("Harness result or finalization revoked pointer input")
        arm = read_json(directory.parent.parent / "arm.json")
        command = read_json(directory / "command.json")
        pointer = read_json(directory / "spell-pointer.json")
        if pointer != request:
            raise PointerError("Pointer request was replaced or revoked")
        now = self.now_ms()
        for artifact in (arm, command):
            if (artifact.get("schemaVersion") != 2 or artifact.get("runId") != request["runId"]
                    or artifact.get("scenarioId") != request["scenarioId"]
                    or artifact.get("mode") != "runtime" or artifact.get("savePolicy") != "never"
                    or artifact.get("saveId") != self.policy["saveId"] or "creationPlan" in artifact
                    or not integer(artifact.get("createdAtEpochMs"))
                    or not integer(artifact.get("expiresAtEpochMs"))
                    or not integer(artifact.get("timeoutMs"), 1)
                    or artifact["expiresAtEpochMs"] - artifact["createdAtEpochMs"] != artifact["timeoutMs"]
                    or now < artifact["createdAtEpochMs"]
                    or not artifact["createdAtEpochMs"] // 1000 * 1000 <= request["observedAtEpochMs"] <= now
                    or not now < request["expiresAtEpochMs"] <= artifact["expiresAtEpochMs"]):
                raise PointerError("Harness arm or command no longer authorizes this pointer")
        assertions = command.get("requiredAssertionIds")
        if (command["createdAtEpochMs"] < arm["createdAtEpochMs"]
                or command["expiresAtEpochMs"] > arm["expiresAtEpochMs"]
                or not isinstance(assertions, list) or not assertions
                or any(not isinstance(item, str) or not item for item in assertions)
                or assertions != arm.get("requiredAssertionIds")):
            raise PointerError("Harness command does not match its arm")
        if self.authorization is not None and self.authorization != (arm, command):
            raise PointerError("Harness arm or command was replaced")
        self.authorization = (arm, command)

    def guard(self, message, expected_cursor=None):
        self.authorize(message)
        validate_process(message["pid"], message["startTimeTicks"], message["saveId"], self.policy)
        active = self.hypr("activewindow")
        monitors = self.hypr("monitors")
        if not isinstance(monitors, list):
            raise PointerError("Hyprland monitor list is invalid")
        window = validate_window(active, monitors, message["pid"], message["request"]["viewport"])
        if self.window is not None and window != self.window:
            raise PointerError("BG3 focus, window identity or geometry changed")
        current = self.cursor()
        if expected_cursor is not None and current != expected_cursor:
            raise PointerError("Another source moved the pointer")
        x, y = window["at"]
        width, height = window["size"]
        if not x <= current["x"] < x + width or not y <= current["y"] < y + height:
            raise PointerError("Pointer is outside the owned BG3 window")
        # Authorization can change while querying the compositor.
        self.authorize(message)
        self.window = window
        return current

    def open_device(self):
        if self.device is None:
            from evdev import UInput, ecodes
            # BTN_LEFT is a device capability for libinput mouse discovery only.
            # No code in this backend writes EV_KEY.
            self.device = UInput({ecodes.EV_KEY: [ecodes.BTN_LEFT],
                                  ecodes.EV_REL: [ecodes.REL_X, ecodes.REL_Y]},
                                 name="BG3 harness relative pointer")
            self.ecodes = ecodes
            time.sleep(0.1)

    def move(self, message, destination):
        current = self.guard(message, self.last_owned_cursor)
        self.open_device()
        for _ in range(30):
            current = self.guard(message, current)
            if current == destination:
                self.last_owned_cursor = current
                return current
            deltas = {}
            for key in ("x", "y"):
                error = destination[key] - current[key]
                deltas[key] = round(error / 2) or (1 if error > 0 else -1 if error < 0 else 0)
            for axis, key in ((self.ecodes.REL_X, "x"), (self.ecodes.REL_Y, "y")):
                if deltas[key]:
                    self.device.write(self.ecodes.EV_REL, axis, deltas[key])
            self.device.syn()
            time.sleep(0.04)
            observed = self.guard(message)
            for key in ("x", "y"):
                distance = observed[key] - current[key]
                # Uncommanded axes and movement against the requested direction
                # are external input. Acceleration may overshoot the target.
                if (deltas[key] == 0 and distance != 0
                        or distance * deltas[key] < 0
                        or abs(distance) > max(4 * abs(deltas[key]), 2)):
                    raise PointerError("Pointer motion does not match the emitted relative input")
            self.movements.append({"from": current, "to": observed, "relative": deltas})
            self.last_owned_cursor = observed
            current = observed
        raise PointerError("Relative pointer did not converge within 30 movements")

    def write_evidence(self, path, value):
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            descriptor = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=directory)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(value)
        finally:
            os.close(directory)

    def capture_label(self, message):
        from PIL import Image
        request = message["request"]
        directory = Path(message["runDirectory"]) / "pointer"
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or directory.resolve().parent != Path(message["runDirectory"]):
            raise PointerError("Pointer evidence directory is not owned by this run")
        x, y = self.window["at"]
        width, height = request["viewport"]
        for attempt in range(MAX_CAPTURE_ATTEMPTS):
            self.guard(message, self.last_owned_cursor)
            timeout = min(3, (request["expiresAtEpochMs"] - self.now_ms()) / 1000)
            if timeout <= 0:
                raise PointerError("Pointer OCR deadline expired")
            prefix = request["stepId"] + "-" if len(self.policy["steps"]) > 1 else ""
            stem = f"{prefix}hover-{attempt:02d}"
            try:
                capture = subprocess.run(
                    ["grim", "-s", "1", "-g", f"{x},{y} {width}x{height}", "-t", "png", "-"],
                    check=True, capture_output=True, timeout=timeout,
                ).stdout
                self.guard(message, self.last_owned_cursor)
                with Image.open(io.BytesIO(capture)) as image:
                    if image.size != (width, height) or image.format != "PNG":
                        raise PointerError("Captured BG3 pixels do not match the viewport")
                    image.verify()
                image_path = directory / (stem + ".png")
                self.write_evidence(image_path, capture)
                timeout = min(3, (request["expiresAtEpochMs"] - self.now_ms()) / 1000)
                if timeout <= 0:
                    raise PointerError("Pointer OCR deadline expired")
                result = subprocess.run(
                    ["tesseract", str(image_path), "stdout", "--psm", "11", "-l", "eng", "tsv"],
                    check=True, capture_output=True, text=True, timeout=timeout,
                )
                self.guard(message, self.last_owned_cursor)
                self.write_evidence(directory / (stem + ".tsv"), result.stdout.encode("utf-8"))
                match = parse_tsv(result.stdout, request["targetLabel"], request["viewport"])
                left, top, box_width, box_height = match["box"]
                return {"x": x + left + box_width // 2, "y": y + top + box_height // 2}, {
                    "match": match, "capture": f"pointer/{stem}.png", "tsv": f"pointer/{stem}.tsv",
                    "attempt": attempt + 1, "viewport": request["viewport"], "window": self.window,
                }
            except LabelNotFound:
                if attempt + 1 == MAX_CAPTURE_ATTEMPTS:
                    raise
                time.sleep(0.15)
            except subprocess.TimeoutExpired:
                if attempt + 1 == MAX_CAPTURE_ATTEMPTS or self.now_ms() >= request["expiresAtEpochMs"]:
                    raise PointerError("Pointer capture or OCR timed out") from None
            except (OSError, subprocess.CalledProcessError) as error:
                raise PointerError("Pointer capture or OCR failed") from error
        raise PointerError("Pointer OCR attempts exhausted")

    def close(self):
        if self.device is not None:
            self.device.close()
            self.device = None
        self.closed = True

    def handle(self, message):
        request = validate_envelope(message, self.now_ms(), self.policy)
        if request is None:
            self.close()
            try:
                current = self.cursor()
            except PointerError:
                current = None
            return {"id": message["id"], "ok": True, "cursor": current, "evidence": {
                "beforeCursor": self.before_cursor, "lastOwnedCursor": self.last_owned_cursor,
                "currentCursor": current, "movedOnClose": False,
            }}
        if self.closed or self.failed:
            raise PointerError("Pointer bridge is already closed or failed")
        owner = {key: message[key] for key in ("pid", "startTimeTicks", "saveId", "runDirectory")}
        if self.owner is not None and self.owner != owner:
            raise PointerError("Pointer process or run ownership changed")
        self.owner = owner
        phase = request["phase"]
        if phase == "hover" and request["sequence"] > 1:
            previous = self.hover_request
            if (self.completed_phases != {"hover", "leave"} or previous is None
                    or previous["sequence"] != request["sequence"] - 1
                    or any(request[key] != previous[key] for key in ("casterUuid", "targetUuid", "viewport"))
                    or request["castGuid"] == previous["castGuid"]):
                raise PointerError("Pointer marked preview requires its completed control with unchanged actors")
            self.guard(message, self.last_owned_cursor)
            self.completed_phases = set()
            self.hover_request = None
        if phase in self.completed_phases:
            raise PointerError("Pointer phase was replayed")
        if phase == "hover":
            if self.hover_request is not None:
                raise PointerError("Pointer already owns a hover step")
            self.hover_request = request.copy()
            self.before_cursor = self.guard(message)
            self.last_owned_cursor = self.before_cursor.copy()
            destination, evidence = self.capture_label(message)
        else:
            if "hover" not in self.completed_phases:
                raise PointerError("Pointer leave lacks a completed hover")
            ignored = {"phase", "observedAtEpochMs", "entries", "projection"}
            if ({key: value for key, value in request.items() if key not in ignored}
                    != {key: value for key, value in self.hover_request.items() if key not in ignored}):
                raise PointerError("Pointer leave does not match its hover step")
            destination = self.before_cursor
            evidence = {"restored": True, "window": self.window}
        initial_movement_count = len(self.movements)
        current = self.move(message, destination)
        self.completed_phases.add(phase)
        evidence.update(beforeCursor=self.before_cursor, lastOwnedCursor=self.last_owned_cursor,
                        currentCursor=current, movements=self.movements[initial_movement_count:])
        return {"id": message["id"], "ok": True, "cursor": current, "evidence": evidence}


def check_dependencies():
    missing = [name for name in ("hyprctl", "grim", "tesseract") if shutil.which(name) is None]
    for module in ("evdev", "PIL.Image"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if not os.access("/dev/uinput", os.W_OK):
        missing.append("/dev/uinput write access")
    if missing:
        raise PointerError("Missing pointer dependencies: " + ", ".join(missing))
    result = subprocess.run(["tesseract", "--list-langs"], check=True, capture_output=True,
                            text=True, timeout=3)
    if "eng" not in result.stdout.splitlines():
        raise PointerError("Tesseract English language data is missing")
    return {"ok": True, "dependencies": ["hyprctl", "grim", "tesseract", "eng", "evdev", "PIL", "uinput-access"]}


def main():
    if sys.argv[1:] == ["--check"]:
        try:
            result = check_dependencies()
        except (PointerError, OSError, subprocess.SubprocessError) as error:
            result = {"ok": False, "error": str(error)}
        print(json.dumps(result), flush=True)
        return 0 if result["ok"] else 1
    if len(sys.argv) != 3 or sys.argv[1] != "--policy":
        print(json.dumps({"ok": False, "error": "Use --check, or --policy <json> for JSON-line mode"}), flush=True)
        return 1
    try:
        policy = parse_policy(sys.argv[2])
    except PointerError as error:
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
        return 1
    bridge = PointerBridge(policy)

    def terminate(_number, _frame):
        raise InterruptedError("Pointer runner terminated")

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    # Linux closes the owned input device when the runner dies, including while
    # this process is waiting for another JSON command.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != bridge.parent_pid:
        bridge.close()
        return 1
    try:
        while True:
            raw = sys.stdin.buffer.readline(MAX_JSON_BYTES + 1)
            if not raw:
                break
            message = None
            try:
                if len(raw) > MAX_JSON_BYTES or not raw.endswith(b"\n"):
                    raise PointerError("Pointer command is oversized or lacks its line terminator")
                message = json.loads(raw)
                response = bridge.handle(message)
            except Exception as error:
                # This is the JSON protocol boundary. Unexpected parser or
                # device errors must close input and produce one failure reply.
                bridge.failed = True
                bridge.close()
                correlation = message.get("id") if isinstance(message, dict) else None
                response = {"id": correlation if isinstance(correlation, str) else None,
                            "ok": False, "error": str(error)}
            print(json.dumps(response, allow_nan=False, separators=(",", ":")), flush=True)
            if bridge.closed:
                break
    except (InterruptedError, BrokenPipeError):
        return 1
    finally:
        bridge.close()
    return 1 if bridge.failed else 0


if __name__ == "__main__":
    sys.exit(main())
