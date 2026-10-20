#!/usr/bin/env python3
"""Pointer backend tests. No BG3 process, desktop input or real uinput device."""

import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("bg3_pointer", Path(__file__).with_name("bg3-pointer.py"))
pointer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pointer)

NOW = 1788791064204
RUN_ID = "run-e410d2dd-27ad-40e6-b9e4-799465e21578"
CASTER_ID = "11111111-1111-1111-1111-111111111111"
TARGET_ID = "01234567-89ab-cdef-0123-456789abcdef"
CAST_ID = "22222222-2222-2222-2222-222222222222"
SAVE_ID = "harness-fixture__AutoSave_0"
POLICY = {"scenarioId": "example.pointer-preview", "saveId": SAVE_ID, "operation": "preview-target",
          "spellId": "Target_Example_Spell", "steps": ["example-target"]}
SELECTED_POLICY = {"scenarioId": "example.selected-cast", "saveId": SAVE_ID, "operation": "cast-selected-target",
                   "spellId": "Target_Example_Selected", "steps": ["selected-step"]}
TWO_STEP_POLICY = {"scenarioId": "example.two-step-preview", "saveId": SAVE_ID, "operation": "inspect-target-validation",
                   "spellId": "Target_Example_Validation", "steps": ["control-step", "marked-step"]}
TSV_HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"


def word(text="HNXABCDEFGH", conf="91.25", x=140, y=80, width=75, height=15, level=5):
    return f"{level}\t1\t1\t1\t1\t1\t{x}\t{y}\t{width}\t{height}\t{conf}\t{text}\n"


def process_stat(pid=42, start="98765", state="S"):
    return f"{pid} (bg3 (native)) " + " ".join([state] + ["0"] * 18 + [start] + ["0"] * 10)


def window_and_monitor():
    window = {"pid": 42, "class": "steam_app_1086940", "mapped": True, "hidden": False,
              "stableId": "abcd1234", "address": "0x1234", "at": [320, 40], "size": [800, 600],
              "monitor": 2, "workspace": {"id": 3}}
    monitor = {"id": 2, "x": 300, "y": 0, "width": 1200, "height": 1000, "scale": 1,
               "transform": 0, "focused": True, "activeWorkspace": {"id": 3}}
    return window, [monitor]


class OCRTests(unittest.TestCase):
    def test_uuid_uses_the_exact_unambiguous_alphabet(self):
        self.assertEqual(pointer.target_label(TARGET_ID), "HNXABCDEFGH")
        self.assertEqual(pointer.target_label("89abcdef-0123-4567-89ab-cdef01234567"), "HNXJKLMNPQR")
        for value in (TARGET_ID.upper(), "../../somewhere", "", None):
            with self.subTest(value=value), self.assertRaises(pointer.PointerError):
                pointer.target_label(value)

    def test_matches_one_word_with_optional_dead_marker(self):
        for text in ("HNXABCDEFGH", "HNXABCDEFGH*"):
            match = pointer.parse_tsv(TSV_HEADER + word(text), "HNXABCDEFGH", [800, 600])
            self.assertEqual(match, {"text": text, "confidence": 91.25, "box": [140, 80, 75, 15]})

    def test_rejects_low_confidence_but_accepts_threshold(self):
        with self.assertRaises(pointer.LabelNotFound):
            pointer.parse_tsv(TSV_HEADER + word(conf="69.99"), "HNXABCDEFGH", [800, 600])
        self.assertEqual(pointer.parse_tsv(TSV_HEADER + word(conf="70"), "HNXABCDEFGH", [800, 600])["confidence"], 70)

    def test_duplicate_even_with_low_confidence_is_ambiguous(self):
        for second in (word(), word("HNXABCDEFGH*"), word(conf="1")):
            with self.subTest(second=second), self.assertRaisesRegex(pointer.PointerError, "ambiguous"):
                pointer.parse_tsv(TSV_HEADER + word() + second, "HNXABCDEFGH", [800, 600])

    def test_never_accepts_a_similar_or_partial_token(self):
        for text in ("Human*", "hnxabcdefgh", "HNXABCDEFG", "HNXABCDEFGH**", "prefixHNXABCDEFGH", "HNXABCDEFGH."):
            with self.subTest(text=text), self.assertRaises(pointer.LabelNotFound):
                pointer.parse_tsv(TSV_HEADER + word(text), "HNXABCDEFGH", [800, 600])

    def test_rejects_invalid_target_boxes(self):
        cases = ({"x": -1}, {"y": -1}, {"width": 0}, {"height": -1}, {"x": 750},
                 {"y": 590}, {"conf": "nan"}, {"conf": "inf"}, {"conf": "101"}, {"x": "1.5"})
        for fields in cases:
            with self.subTest(fields=fields), self.assertRaises(pointer.PointerError):
                pointer.parse_tsv(TSV_HEADER + word(**fields), "HNXABCDEFGH", [800, 600])

    def test_ignores_nonword_rows_and_rejects_broken_tsv(self):
        with self.assertRaises(pointer.LabelNotFound):
            pointer.parse_tsv(TSV_HEADER + word(level=4), "HNXABCDEFGH", [800, 600])
        with self.assertRaises(pointer.PointerError):
            pointer.parse_tsv("text\nHNXABCDEFGH\n", "HNXABCDEFGH", [800, 600])


class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.process = self.root / "42"
        self.process.mkdir()
        (self.process / "stat").write_text(process_stat())
        self.write_arguments(["/game/bg3_dx11.exe", "-loadSaveGame", SAVE_ID])

    def write_arguments(self, arguments):
        (self.process / "cmdline").write_bytes("\0".join(arguments).encode() + b"\0")

    def test_exact_pid_start_and_adjacent_save_are_required(self):
        pointer.validate_process(42, "98765", SAVE_ID, POLICY, self.root)
        with self.assertRaisesRegex(pointer.PointerError, "reused"):
            pointer.validate_process(42, "12345", SAVE_ID, POLICY, self.root)
        self.write_arguments(["bg3.exe", "-loadSaveGame", "ProtectedSave", SAVE_ID])
        with self.assertRaisesRegex(pointer.PointerError, "another save"):
            pointer.validate_process(42, "98765", SAVE_ID, POLICY, self.root)

    def test_continue_duplicate_and_nonadjacent_save_fail(self):
        cases = [
            ["bg3.exe", "-continueGame", "-loadSaveGame", SAVE_ID],
            ["bg3.exe", "-loadSaveGame", SAVE_ID, "-loadSaveGame", SAVE_ID],
            ["bg3.exe", "-loadSaveGame=other", "-loadSaveGame", SAVE_ID],
            ["bg3.exe", "-loadSaveGame", "-other", SAVE_ID],
        ]
        for arguments in cases:
            self.write_arguments(arguments)
            with self.subTest(arguments=arguments), self.assertRaises(pointer.PointerError):
                pointer.validate_process(42, "98765", SAVE_ID, POLICY, self.root)

    def test_dead_or_disappearing_process_revokes_ownership(self):
        for state in ("Z", "X"):
            (self.process / "stat").write_text(process_stat(state=state))
            with self.assertRaises(pointer.PointerError):
                pointer.validate_process(42, "98765", SAVE_ID, POLICY, self.root)
        (self.process / "stat").unlink()
        with self.assertRaises(pointer.PointerError):
            pointer.validate_process(42, "98765", SAVE_ID, POLICY, self.root)


class WindowTests(unittest.TestCase):
    def test_accepts_arbitrary_unscaled_monitor_and_window_origins(self):
        window, monitors = window_and_monitor()
        result = pointer.validate_window(window, monitors, 42, [800, 600])
        self.assertEqual(result["at"], [320, 40])
        self.assertEqual(result["monitor"]["x"], 300)

    def test_rejects_other_focus_unmapped_window_and_viewport_mismatch(self):
        for change in ({"pid": 43}, {"class": "some-user-app"}, {"mapped": False},
                       {"size": [801, 600]}, {"stableId": None}, {"hidden": True}):
            window, monitors = window_and_monitor()
            window.update(change)
            with self.subTest(change=change), self.assertRaises(pointer.PointerError):
                pointer.validate_window(window, monitors, 42, [800, 600])

    def test_rejects_scaling_rotation_monitor_change_and_crossing(self):
        for change in ({"scale": 1.5}, {"transform": 1}, {"focused": False}, {"width": 700},
                       {"activeWorkspace": {"id": 4}}, {"mirrorOf": "other"}):
            window, monitors = window_and_monitor()
            monitors[0].update(change)
            with self.subTest(change=change), self.assertRaises(pointer.PointerError):
                pointer.validate_window(window, monitors, 42, [800, 600])


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "TestHarness" / "runs" / RUN_ID
        self.directory.mkdir(parents=True)
        self.request = {
            "schemaVersion": 2, "runId": RUN_ID, "scenarioId": POLICY["scenarioId"],
            "stepId": "example-target", "sequence": 1, "operation": "preview-target",
            "casterUuid": CASTER_ID, "targetUuid": TARGET_ID, "spellId": POLICY["spellId"],
            "castGuid": CAST_ID, "phase": "hover", "targetLabel": pointer.target_label(TARGET_ID),
            "observedAtEpochMs": NOW, "expiresAtEpochMs": NOW + 20000, "viewport": [800, 600],
            "entries": [{"uuid": TARGET_ID, "objectType": "ls.Character"}],
        }
        self.message = {"id": "pointer-1", "action": "hover", "pid": 42, "startTimeTicks": "98765",
                        "saveId": SAVE_ID, "runDirectory": str(self.directory), "request": self.request}
        self.arm = {"schemaVersion": 2, "runId": RUN_ID, "scenarioId": self.request["scenarioId"],
                    "mode": "runtime", "savePolicy": "never", "saveId": SAVE_ID,
                    "createdAtEpochMs": NOW - 10000, "expiresAtEpochMs": NOW + 100000,
                    "timeoutMs": 110000, "requiredAssertionIds": ["target-correct"]}
        self.arm_path = self.directory.parent.parent / "arm.json"
        self.command_path = self.directory / "command.json"
        self.pointer_path = self.directory / "spell-pointer.json"
        self.arm_path.write_text(json.dumps(self.arm))
        self.command_path.write_text(json.dumps(self.arm))
        self.pointer_path.write_text(json.dumps(self.request))
        self.use_policy(POLICY)

    def use_policy(self, policy):
        self.policy = policy
        self.bridge = pointer.PointerBridge(policy)
        self.bridge.now_ms = lambda: NOW

    def test_valid_request_and_artifacts_authorize(self):
        self.assertEqual(pointer.validate_envelope(self.message, NOW, self.policy), self.request)
        self.bridge.authorize(self.message)

    def use_selected_request(self):
        self.use_policy(SELECTED_POLICY)
        self.request.update({"scenarioId": SELECTED_POLICY["scenarioId"],
                             "stepId": "selected-step", "sequence": 1,
                             "operation": "cast-selected-target", "spellId": SELECTED_POLICY["spellId"]})
        self.arm["scenarioId"] = self.request["scenarioId"]
        self.arm_path.write_text(json.dumps(self.arm))
        self.command_path.write_text(json.dumps(self.arm))
        self.pointer_path.write_text(json.dumps(self.request))

    def test_selected_cast_exact_step_and_artifacts_authorize(self):
        self.use_selected_request()
        self.assertEqual(pointer.validate_envelope(self.message, NOW, self.policy), self.request)
        self.bridge.authorize(self.message)

    def use_protection_request(self):
        self.use_policy(TWO_STEP_POLICY)
        self.request.update({"scenarioId": TWO_STEP_POLICY["scenarioId"],
                             "stepId": "control-step", "sequence": 1,
                             "operation": "inspect-target-validation", "spellId": TWO_STEP_POLICY["spellId"]})
        self.arm["scenarioId"] = self.request["scenarioId"]
        self.arm_path.write_text(json.dumps(self.arm))
        self.command_path.write_text(json.dumps(self.arm))
        self.pointer_path.write_text(json.dumps(self.request))

    def test_protection_previews_use_two_complete_pairs_without_cast(self):
        self.use_protection_request()
        state = self.prepare_guard()
        self.bridge.capture_label = Mock(return_value=({"x": 500, "y": 300}, {}))

        def move(message, destination):
            self.bridge.guard(message, self.bridge.last_owned_cursor)
            state["cursorpos"] = destination.copy()
            self.bridge.last_owned_cursor = destination.copy()
            return destination

        self.bridge.move = move
        with patch.object(pointer, "validate_process"):
            for sequence, step, cast in ((1, "control-step", CAST_ID),
                                         (2, "marked-step", "33333333-3333-3333-3333-333333333333")):
                self.request.update(sequence=sequence, stepId=step, castGuid=cast)
                for phase in ("hover", "leave"):
                    self.request["phase"] = self.message["action"] = phase
                    self.pointer_path.write_text(json.dumps(self.request))
                    result = self.bridge.handle(self.message)
                    self.assertEqual(result["cursor"], {"x": 500, "y": 300} if phase == "hover" else {"x": 400, "y": 400})
            self.assertEqual(self.bridge.capture_label.call_count, 2)
            self.assertIsNone(self.bridge.device)

    def test_protection_rejects_skipped_or_crossed_steps(self):
        self.use_protection_request()
        self.assertEqual(pointer.validate_envelope(self.message, NOW, self.policy), self.request)
        for change in ({"stepId": "marked-step"}, {"sequence": 2}, {"sequence": True},
                       {"operation": "cast-target"}, {"spellId": POLICY["spellId"]}):
            message = copy.deepcopy(self.message)
            message["request"].update(change)
            with self.subTest(change=change), self.assertRaises(pointer.PointerError):
                pointer.validate_envelope(message, NOW, self.policy)
        self.request.update(sequence=2, stepId="marked-step")
        with self.assertRaises(pointer.PointerError):
            self.bridge.handle(self.message)

    def test_protection_second_capture_has_separate_evidence_files(self):
        from PIL import Image
        self.use_protection_request()
        state = self.prepare_guard()
        self.bridge.window = pointer.validate_window(state["activewindow"], state["monitors"], 42, [800, 600])
        self.bridge.last_owned_cursor = state["cursorpos"].copy()
        encoded = io.BytesIO()
        Image.new("RGB", (800, 600)).save(encoded, format="PNG")
        def run(arguments, **_options):
            return Mock(stdout=encoded.getvalue() if arguments[0] == "grim" else TSV_HEADER + word())
        with patch.object(pointer, "validate_process"), patch.object(pointer.subprocess, "run", side_effect=run):
            _, first = self.bridge.capture_label(self.message)
            self.request.update(sequence=2, stepId="marked-step", castGuid="33333333-3333-3333-3333-333333333333")
            self.pointer_path.write_text(json.dumps(self.request))
            _, second = self.bridge.capture_label(self.message)
        self.assertNotEqual(first["capture"], second["capture"])
        self.assertTrue((self.directory / first["capture"]).is_file())
        self.assertTrue((self.directory / second["capture"]).is_file())

    def test_selected_cast_rejects_crossed_step_spell_operation_and_actor(self):
        self.use_selected_request()
        for change in ({"stepId": "example-target"}, {"stepId": "selected-step-repeat"},
                       {"sequence": 2}, {"sequence": True}, {"operation": "cast-target"},
                       {"operation": "preview-target"}, {"spellId": POLICY["spellId"]},
                       {"spellId": "Target_Other"}, {"casterUuid": TARGET_ID},
                       {"scenarioId": POLICY["scenarioId"]}):
            message = copy.deepcopy(self.message)
            message["request"].update(change)
            with self.subTest(change=change), self.assertRaises(pointer.PointerError):
                pointer.validate_envelope(message, NOW, self.policy)

    def test_selected_arm_cannot_authorize_another_scenario_and_replaced_pointer_revokes(self):
        self.use_selected_request()
        self.arm_path.write_text(json.dumps({**self.arm, "scenarioId": POLICY["scenarioId"]}))
        with self.assertRaises(pointer.PointerError):
            self.bridge.authorize(self.message)
        self.arm_path.write_text(json.dumps(self.arm))
        self.bridge.authorize(self.message)
        self.pointer_path.write_text(json.dumps({**self.request, "spellId": POLICY["spellId"]}))
        with self.assertRaisesRegex(pointer.PointerError, "replaced"):
            self.bridge.authorize(self.message)

    def test_wrong_token_future_stale_and_expired_requests_are_rejected(self):
        changes = ({"targetLabel": "Human"}, {"observedAtEpochMs": NOW + 1},
                   {"observedAtEpochMs": NOW - 2001}, {"expiresAtEpochMs": NOW},
                   {"schemaVersion": 1}, {"casterUuid": "00000000-0000-0000-0000-000000000000"},
                   {"operation": "cast-target"})
        for change in changes:
            message = copy.deepcopy(self.message)
            message["request"].update(change)
            with self.subTest(change=change), self.assertRaises(pointer.PointerError):
                pointer.validate_envelope(message, NOW, self.policy)

    def test_same_request_remains_valid_until_deadline_without_refreshed_timestamp(self):
        self.bridge.authorize(self.message)
        self.bridge.now_ms = lambda: NOW + 10000
        self.bridge.authorize(self.message)
        self.bridge.now_ms = lambda: NOW + 20000
        with self.assertRaises(pointer.PointerError):
            self.bridge.authorize(self.message)

    def test_client_clock_can_be_rounded_down_within_the_command_second(self):
        self.request["observedAtEpochMs"] = NOW // 1000 * 1000
        self.pointer_path.write_text(json.dumps(self.request))
        self.command_path.write_text(json.dumps({**self.arm, "createdAtEpochMs": NOW,
                                               "timeoutMs": 100000}))
        pointer.validate_envelope(self.message, NOW, self.policy)
        self.bridge.authorize(self.message)

    def test_labels_need_unique_exact_character_and_projection_is_only_diagnostic(self):
        for entries in ([], [{"uuid": CASTER_ID, "objectType": "ls.Character"}],
                        [{"uuid": TARGET_ID, "objectType": "ls.Item"}], self.request["entries"] * 2):
            message = copy.deepcopy(self.message)
            message["request"]["entries"] = entries
            with self.subTest(entries=entries), self.assertRaises(pointer.PointerError):
                pointer.validate_envelope(message, NOW, self.policy)
        self.request["projection"] = {"error": "not-selectable", "x": 9999}
        pointer.validate_envelope(self.message, NOW, self.policy)
        self.request["unexpected"] = True
        with self.assertRaises(pointer.PointerError):
            pointer.validate_envelope(self.message, NOW, self.policy)

    def test_finalization_or_result_revokes_even_when_malformed(self):
        for name in ("result.json", "server-finalizing.json"):
            path = self.directory / name
            path.write_text("in progress")
            with self.subTest(name=name), self.assertRaisesRegex(pointer.PointerError, "revoked"):
                self.bridge.authorize(self.message)
            path.unlink()

    def test_replaced_pointer_arm_or_command_revokes(self):
        self.bridge.authorize(self.message)
        self.pointer_path.write_text(json.dumps({**self.request, "phase": "leave"}))
        with self.assertRaisesRegex(pointer.PointerError, "replaced"):
            self.bridge.authorize(self.message)
        self.pointer_path.write_text(json.dumps(self.request))
        self.arm_path.write_text(json.dumps({**self.arm, "additional": True}))
        with self.assertRaisesRegex(pointer.PointerError, "replaced"):
            self.bridge.authorize(self.message)

    def test_missing_or_symlink_arm_revokes(self):
        self.arm_path.unlink()
        with self.assertRaises(pointer.PointerError):
            self.bridge.authorize(self.message)
        self.arm_path.symlink_to(self.command_path)
        with self.assertRaises(pointer.PointerError):
            self.bridge.authorize(self.message)

    def test_parent_death_revokes_before_any_device_work(self):
        with patch.object(pointer.os, "getppid", return_value=self.bridge.parent_pid + 1):
            with self.assertRaisesRegex(pointer.PointerError, "runner disappeared"):
                self.bridge.authorize(self.message)

    def prepare_guard(self):
        window, monitors = window_and_monitor()
        state = {"activewindow": window, "monitors": monitors, "cursorpos": {"x": 400, "y": 400}}
        self.bridge.hypr = lambda query: copy.deepcopy(state[query])
        return state

    def test_focus_cursor_and_geometry_change_abort_guard(self):
        state = self.prepare_guard()
        with patch.object(pointer, "validate_process"):
            self.bridge.guard(self.message, {"x": 400, "y": 400})
            state["cursorpos"]["x"] += 1
            with self.assertRaisesRegex(pointer.PointerError, "Another source"):
                self.bridge.guard(self.message, {"x": 400, "y": 400})
            state["activewindow"]["stableId"] = "ffff"
            with self.assertRaisesRegex(pointer.PointerError, "changed"):
                self.bridge.guard(self.message)

    def test_hover_replay_foreign_leave_and_leave_before_hover_fail(self):
        state = self.prepare_guard()
        self.bridge.capture_label = Mock(return_value=({"x": 500, "y": 300}, {}))
        self.bridge.move = Mock(return_value={"x": 500, "y": 300})
        with patch.object(pointer, "validate_process"):
            self.bridge.handle(self.message)
            with self.assertRaisesRegex(pointer.PointerError, "replayed"):
                self.bridge.handle(self.message)
            leave = copy.deepcopy(self.message)
            leave["action"] = leave["request"]["phase"] = "leave"
            leave["request"]["castGuid"] = "33333333-3333-3333-3333-333333333333"
            with self.assertRaisesRegex(pointer.PointerError, "does not match"):
                self.bridge.handle(leave)
            new_bridge = pointer.PointerBridge(self.policy)
            new_bridge.now_ms = lambda: NOW
            with self.assertRaisesRegex(pointer.PointerError, "lacks a completed hover"):
                new_bridge.handle(leave)

    def test_close_only_closes_device_and_reports_cursor(self):
        device = Mock()
        self.bridge.device = device
        self.bridge.before_cursor = {"x": 400, "y": 400}
        self.bridge.last_owned_cursor = {"x": 500, "y": 300}
        self.bridge.cursor = lambda: {"x": 900, "y": 300}
        result = self.bridge.handle({"id": "close-1", "action": "close"})
        device.close.assert_called_once_with()
        device.write.assert_not_called()
        self.assertFalse(result["evidence"]["movedOnClose"])
        self.assertEqual(result["evidence"]["currentCursor"], {"x": 900, "y": 300})
        self.assertEqual(result["evidence"]["lastOwnedCursor"], {"x": 500, "y": 300})

    def test_relative_motion_converges_and_never_emits_key_events(self):
        state = self.prepare_guard()
        position = state["cursorpos"]

        class Codes:
            EV_REL = 2
            REL_X = 0
            REL_Y = 1

        emitted = []

        class Device:
            def write(self, kind, axis, delta):
                emitted.append((kind, axis, delta))
                position["x" if axis == Codes.REL_X else "y"] += delta * 2

            def syn(self):
                pass

        self.bridge.device = Device()
        self.bridge.ecodes = Codes()
        self.bridge.last_owned_cursor = {"x": 400, "y": 400}
        with patch.object(pointer, "validate_process"), patch.object(pointer.time, "sleep"):
            result = self.bridge.move(self.message, {"x": 500, "y": 300})
        self.assertEqual(result, {"x": 500, "y": 300})
        self.assertTrue(emitted)
        self.assertTrue(all(event[0] == Codes.EV_REL for event in emitted))

    def test_leave_restores_only_the_owned_cursor_with_same_step(self):
        state = self.prepare_guard()
        self.bridge.capture_label = Mock(return_value=({"x": 500, "y": 300}, {}))

        def move(message, destination):
            self.bridge.guard(message, self.bridge.last_owned_cursor)
            state["cursorpos"] = destination.copy()
            self.bridge.last_owned_cursor = destination.copy()
            return destination

        self.bridge.move = move
        with patch.object(pointer, "validate_process"):
            hover = self.bridge.handle(self.message)
            self.assertEqual(hover["cursor"], {"x": 500, "y": 300})
            self.request["phase"] = self.message["action"] = "leave"
            self.pointer_path.write_text(json.dumps(self.request))
            leave = self.bridge.handle(self.message)
        self.assertEqual(leave["cursor"], {"x": 400, "y": 400})
        self.assertTrue(leave["evidence"]["restored"])

    def test_capture_uses_window_origin_and_archive_paths_without_input(self):
        from PIL import Image
        state = self.prepare_guard()
        self.bridge.window = pointer.validate_window(state["activewindow"], state["monitors"], 42, [800, 600])
        self.bridge.last_owned_cursor = state["cursorpos"].copy()
        encoded = io.BytesIO()
        Image.new("RGB", (800, 600)).save(encoded, format="PNG")
        commands = []

        def run(arguments, **options):
            commands.append(arguments)
            if arguments[0] == "grim":
                return Mock(stdout=encoded.getvalue())
            return Mock(stdout=TSV_HEADER + word())

        with patch.object(pointer, "validate_process"), patch.object(pointer.subprocess, "run", side_effect=run):
            destination, evidence = self.bridge.capture_label(self.message)
        self.assertEqual(destination, {"x": 320 + 140 + 37, "y": 40 + 80 + 7})
        self.assertEqual(commands[0], ["grim", "-s", "1", "-g", "320,40 800x600", "-t", "png", "-"])
        self.assertEqual(evidence["capture"], "pointer/hover-00.png")
        self.assertTrue((self.directory / evidence["capture"]).is_file())
        self.assertTrue((self.directory / evidence["tsv"]).is_file())
        self.assertIsNone(self.bridge.device)

    def test_ambiguous_capture_stops_without_opening_device_or_retrying(self):
        from PIL import Image
        state = self.prepare_guard()
        self.bridge.window = pointer.validate_window(state["activewindow"], state["monitors"], 42, [800, 600])
        self.bridge.last_owned_cursor = state["cursorpos"].copy()
        encoded = io.BytesIO()
        Image.new("RGB", (800, 600)).save(encoded, format="PNG")
        outputs = [Mock(stdout=encoded.getvalue()), Mock(stdout=TSV_HEADER + word() + word(x=300))]
        with patch.object(pointer, "validate_process"), patch.object(pointer.subprocess, "run", side_effect=outputs) as run:
            with self.assertRaisesRegex(pointer.PointerError, "ambiguous"):
                self.bridge.capture_label(self.message)
        self.assertEqual(run.call_count, 2)
        self.assertIsNone(self.bridge.device)

    def test_revocation_between_motion_frames_stops_before_next_write(self):
        state = self.prepare_guard()
        position = state["cursorpos"]
        emitted = []

        class Codes:
            EV_REL = 2
            REL_X = 0
            REL_Y = 1

        class Device:
            def write(self, kind, axis, delta):
                emitted.append((kind, axis, delta))
                position["x" if axis == Codes.REL_X else "y"] += delta

            def syn(inner_self):
                (self.directory / "server-finalizing.json").write_text("{}")

        self.bridge.device = Device()
        self.bridge.ecodes = Codes()
        self.bridge.last_owned_cursor = {"x": 400, "y": 400}
        with patch.object(pointer, "validate_process"), patch.object(pointer.time, "sleep"):
            with self.assertRaisesRegex(pointer.PointerError, "revoked"):
                self.bridge.move(self.message, {"x": 600, "y": 400})
        self.assertEqual(len(emitted), 1)


if __name__ == "__main__":
    unittest.main()
