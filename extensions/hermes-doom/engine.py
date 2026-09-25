#!/usr/bin/env python3
"""Local Doom watch server for the Hermes Dashboard Games tab.

Serves a small browser page plus an MJPEG stream. If ViZDoom is available, it
runs a simple autonomous policy in the bundled basic scenario. Without ViZDoom,
it falls back to an animated demo page so the dashboard wiring can be tested.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import random
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover - exercised manually when Pillow missing
    Image = None
    ImageDraw = None
    ImageFont = None

try:
    import vizdoom as vzd
except Exception:  # pragma: no cover - optional runtime dependency
    vzd = None

SCRIPT_DIR = Path(__file__).resolve().parent
DOOM_SHAREWARE_WAD = SCRIPT_DIR.parent / "wads" / "doom1.wad"
LEARNING_POLICY_PATH = SCRIPT_DIR.parent / "doom_learning_policy_v3.json"
SUCCESS_TRAJECTORY_PATH = SCRIPT_DIR.parent / "doom_success_trajectories_v3.jsonl"
POLICY_SCHEMA_VERSION = 3
STATE_KEY_VERSION = "spatial_v3"
SCENARIOS = {
    "doom_shareware_episode": {"config": "doom.cfg", "map": "E1M1", "episode": True, "name": "Doom Shareware Episode"},
    "doom_shareware_e1m1": {"config": "doom.cfg", "map": "E1M1", "name": "Doom Shareware E1M1"},
    "deadly_corridor": {"config": "deadly_corridor.cfg", "name": "Deadly Corridor"},
    "defend_the_center": {"config": "defend_the_center.cfg", "name": "Defend The Center"},
    "defend_the_line": {"config": "defend_the_line.cfg", "name": "Defend The Line"},
    "health_gathering": {"config": "health_gathering.cfg", "name": "Health Gathering"},
    "my_way_home": {"config": "my_way_home.cfg", "name": "My Way Home"},
}
SHAREWARE_EPISODE_MAPS = ["E1M1", "E1M2", "E1M3", "E1M4", "E1M5", "E1M6", "E1M7", "E1M8", "E1M9"]
MAPS = {name: name for name in SHAREWARE_EPISODE_MAPS}
WEAPONS = {
    "auto": "Auto weapon",
    "1": "Fist/chainsaw",
    "2": "Pistol",
    "3": "Shotgun",
    "4": "Chaingun",
    "5": "Rocket launcher",
    "6": "Plasma rifle",
    "7": "BFG 9000",
}
LEARNED_ACTIONS = {
    "forward": ["MOVE_FORWARD"],
    "forward_left": ["MOVE_FORWARD", "TURN_LEFT"],
    "forward_right": ["MOVE_FORWARD", "TURN_RIGHT"],
    "turn_left": ["TURN_LEFT"],
    "turn_right": ["TURN_RIGHT"],
    "strafe_left": ["MOVE_LEFT"],
    "strafe_right": ["MOVE_RIGHT"],
    "back_left": ["MOVE_BACKWARD", "TURN_LEFT"],
    "back_right": ["MOVE_BACKWARD", "TURN_RIGHT"],
    "retreat": ["MOVE_BACKWARD"],
    "use_forward": ["USE", "MOVE_FORWARD"],
    "use": ["USE"],
    "attack": ["ATTACK"],
    "attack_forward": ["ATTACK", "MOVE_FORWARD"],
    "attack_forward_left": ["ATTACK", "MOVE_FORWARD", "TURN_LEFT"],
    "attack_forward_right": ["ATTACK", "MOVE_FORWARD", "TURN_RIGHT"],
    "attack_strafe_left": ["ATTACK", "MOVE_LEFT"],
    "attack_strafe_right": ["ATTACK", "MOVE_RIGHT"],
    "attack_retreat": ["ATTACK", "MOVE_BACKWARD"],
    "attack_back_left": ["ATTACK", "MOVE_BACKWARD", "TURN_LEFT"],
    "attack_back_right": ["ATTACK", "MOVE_BACKWARD", "TURN_RIGHT"],
    # Macro/options: still represented as button combos, but held longer by
    # ACTION_TICS to shorten route-learning horizons.
    "corridor_forward": ["MOVE_FORWARD"],
    "wall_follow_left": ["MOVE_FORWARD", "TURN_LEFT"],
    "wall_follow_right": ["MOVE_FORWARD", "TURN_RIGHT"],
    "door_probe": ["USE", "MOVE_FORWARD"],
    "unstuck_spin_scan": ["MOVE_BACKWARD", "TURN_RIGHT"],
    "attack_until_clear": ["ATTACK", "MOVE_FORWARD"],
}
ACTION_TICS = {
    "corridor_forward": 8,
    "wall_follow_left": 7,
    "wall_follow_right": 7,
    "door_probe": 10,
    "unstuck_spin_scan": 8,
    "attack_until_clear": 6,
}
SAFE_EXPLORATION_ACTIONS = [
    "forward", "forward_left", "forward_right", "corridor_forward",
    "wall_follow_left", "wall_follow_right", "door_probe",
]


class DoomState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.frame: bytes = b""
        self.status = {
            "mode": "starting",
            "tick": 0,
            "score": 0,
            "episode": 0,
            "message": "Starting Doom watch server",
        }
        self.controls = {
            # Reliability curriculum: default to the single-map E1M1 scenario so
            # repeated attempts train/validate the Hangar exit instead of
            # immediately advancing to later maps after one lucky completion.
            "scenario": "doom_shareware_e1m1",
            "map": "E1M1",
            "difficulty": 3,
            "weapon": "auto",
            "auto_restart": True,
            "aggressive": True,
            "god_mode": False,
            "idkfa": False,
            "show_hud": True,
            "self_improve": True,
            "freeze_learning": False,
            "revision": 0,
        }
        self.learning_reset_requested = False
        self.stop = False

    def set_frame(self, frame: bytes, **status) -> None:
        with self.lock:
            self.frame = frame
            self.status.update(status)

    def snapshot(self) -> tuple[bytes, dict]:
        with self.lock:
            status = dict(self.status)
            status["controls"] = dict(self.controls)
            status["scenarios"] = {key: value["name"] for key, value in SCENARIOS.items()}
            status["maps"] = MAPS
            status["weapons"] = WEAPONS
            return self.frame, status

    def update_controls(self, updates: dict) -> dict:
        with self.lock:
            if updates.get("scenario") in SCENARIOS:
                self.controls["scenario"] = updates["scenario"]
            if str(updates.get("map", "")).upper() in MAPS:
                self.controls["map"] = str(updates["map"]).upper()
            if str(updates.get("weapon", "")) in WEAPONS:
                self.controls["weapon"] = str(updates["weapon"])
            if "difficulty" in updates:
                try:
                    self.controls["difficulty"] = max(1, min(5, int(updates["difficulty"])))
                except (TypeError, ValueError):
                    pass
            for key in ("auto_restart", "aggressive", "god_mode", "idkfa", "show_hud", "self_improve"):
                if key in updates:
                    self.controls[key] = bool(updates[key])
            if updates.get("reset_learning") and not self.controls.get("freeze_learning"):
                try:
                    LEARNING_POLICY_PATH.unlink(missing_ok=True)
                except Exception:
                    pass
                self.learning_reset_requested = True
            if updates.get("restart", True):
                self.controls["revision"] += 1
            return dict(self.controls)

    def controls_snapshot(self) -> dict:
        with self.lock:
            return dict(self.controls)

    def consume_learning_reset(self) -> bool:
        with self.lock:
            requested = self.learning_reset_requested
            self.learning_reset_requested = False
            return requested


def jpeg_placeholder(text: str, tick: int, mode: str = "demo") -> bytes:
    if Image is None:
        # Tiny valid-ish fallback is not worth handcrafting; status endpoint will
        # still explain the missing dependency.
        return b""
    img = Image.new("RGB", (640, 360), (8, 8, 12))
    draw = ImageDraw.Draw(img)
    pulse = int(40 + 35 * (1 + __import__("math").sin(tick / 6)))
    draw.rectangle((0, 0, 639, 359), outline=(180, 32 + pulse, 32), width=5)
    draw.text((28, 28), "HERMES DOOM WATCH", fill=(255, 70, 70))
    draw.text((28, 72), text, fill=(235, 235, 235))
    draw.text((28, 112), f"mode={mode} tick={tick}", fill=(180, 180, 180))
    draw.text((28, 300), "Install vizdoom + pillow for live Doom frames", fill=(255, 190, 90))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def frame_from_vizdoom(screen) -> bytes:
    if Image is None:
        return b""
    # ViZDoom screen buffer is CHW RGB by default in modern versions.
    try:
        import numpy as np

        arr = screen
        if getattr(arr, "ndim", 0) == 3 and arr.shape[0] in (1, 3, 4):
            arr = np.transpose(arr[:3], (1, 2, 0))
        img = Image.fromarray(arr.astype("uint8"), "RGB")
    except Exception:
        img = Image.new("RGB", (640, 360), (20, 20, 20))
    img = img.resize((640, 360))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


HEALTH_PICKUPS = frozenset(("stimpack", "medikit", "healthbonus", "soulsphere", "megasphere"))


def visible_health_pickups(game_state):
    return [label for label in getattr(game_state, "labels", [])
            if str(label.object_name).lower() in HEALTH_PICKUPS]


class OnlineDoomLearner:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.q: dict[str, dict[str, float]] = {}
        self.visits: dict[str, dict[str, int]] = {}
        self.steps = 0
        self.deaths = 0
        self.completions: dict[str, int] = {}
        self.last_save = 0
        self.alpha = 0.18
        self.gamma = 0.9999  # discount per engine tic, not per variable-length decision
        self.base_epsilon = 0.16
        self.min_epsilon = 0.04
        self.epsilon = self.base_epsilon
        self.q_takeover_min_visits = 3
        self.q_takeover_min_spread = 0.2
        self.context = "doom_shareware_e1m1:skill3:god0:items0:weaponauto"
        self.episode_cells = {}
        self.last_source = "warmup"
        self.load()

    def load(self) -> None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return
        # Never overwrite/reinterpret incompatible data, including old counters.
        if not isinstance(payload, dict):
            return
        if (payload.get("schema_version") != POLICY_SCHEMA_VERSION or
                payload.get("state_key_version") != STATE_KEY_VERSION or
                payload.get("gamma_per_tic") != self.gamma):
            self.path = self.path.with_name(self.path.stem + ".v3" + self.path.suffix)
            if self.path.exists(): self.load()
            return
        raw_q = payload.get("q", {})
        raw_visits = payload.get("visits", {})
        for key, row in raw_q.items():
            if not key.startswith(STATE_KEY_VERSION + "|") or not isinstance(row, dict): continue
            self.q[key] = {a: float(v) for a, v in row.items()
                           if a in LEARNED_ACTIONS and isinstance(v, (int, float)) and math.isfinite(v)}
            self.visits[key] = {a: max(0, int(v)) for a, v in raw_visits.get(key, {}).items()
                                if a in LEARNED_ACTIONS and isinstance(v, (int, float)) and math.isfinite(v)}
        self.steps = int(payload.get("steps", 0))
        self.deaths = int(payload.get("deaths", 0))
        self.completions = payload.get("completions", {})
        self._refresh_epsilon()

    def set_context(self, controls):
        self.context = (f"{controls.get('scenario', 'doom_shareware_e1m1')}:"
                        f"skill{controls.get('difficulty', 3)}:god{int(bool(controls.get('god_mode')))}:"
                        f"items{int(bool(controls.get('idkfa')))}:weapon{controls.get('weapon', 'auto')}")

    def reset_episode(self):
        self.episode_cells.clear()

    def save(self, force: bool = False) -> None:
        if not force and self.steps - self.last_save < 80:
            return
        payload = {
            "schema_version": POLICY_SCHEMA_VERSION,
            "state_key_version": STATE_KEY_VERSION,
            "gamma_per_tic": self.gamma,
            "steps": self.steps,
            "deaths": self.deaths,
            "completions": self.completions,
            "q": self.q,
            "visits": self.visits,
        }
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
        tmp_path.replace(self.path)
        self.last_save = self.steps

    def _refresh_epsilon(self) -> None:
        # Exploration should keep happening, but not enough to suicide on maps it
        # already understands. Decay slowly with experience and clamp to a small
        # floor so doors/corners can still be discovered.
        self.epsilon = max(self.min_epsilon, self.base_epsilon * math.exp(-self.steps / 18000.0))

    def record_death(self) -> None:
        self.deaths += 1
        self.save(force=True)

    def record_completion(self, map_name: str) -> None:
        key = str(map_name).upper()
        self.completions[key] = int(self.completions.get(key, 0)) + 1
        self.save(force=True)

    def state_key(self, game, game_state, stuck_ticks: int, current_map: str = "") -> str:
        labels = getattr(game_state, "labels", []) if game_state else []
        monsters = [label for label in labels if label.object_category == "Monster"]
        pickups = visible_health_pickups(game_state)
        health = int(game.get_game_variable(vzd.GameVariable.HEALTH))
        ammo = int(game.get_game_variable(vzd.GameVariable.SELECTED_WEAPON_AMMO))
        if monsters:
            target = max(monsters, key=lambda label: label.width * label.height)
            center = target.x + target.width / 2
            if center < 125:
                target_bucket = "monster_left"
            elif center > 195:
                target_bucket = "monster_right"
            else:
                target_bucket = "monster_center"
            distance_bucket = "near" if target.width > 48 else "far"
        else:
            target_bucket = "no_monster"
            distance_bucket = "none"
        if pickups:
            pickup = max(pickups, key=lambda label: label.width * label.height)
            pickup_center = pickup.x + pickup.width / 2
            if pickup_center < 125:
                pickup_bucket = "pickup_left"
            elif pickup_center > 195:
                pickup_bucket = "pickup_right"
            else:
                pickup_bucket = "pickup_center"
        else:
            pickup_bucket = "no_pickup"
        if health < 20:
            health_bucket = "critical_hp"
        elif health < 45:
            health_bucket = "low_hp"
        else:
            health_bucket = "ok_hp"
        # Healthy navigation does not need individual pickup screen positions.
        if health >= 45: pickup_bucket = "no_pickup"
        ammo_bucket = "ammo" if ammo > 0 else "empty"
        if stuck_ticks > 18:
            stuck_bucket = "stuck_high"
        elif stuck_ticks > 0:
            stuck_bucket = "stuck_low"
        else:
            stuck_bucket = "moving"
        map_bucket = str(current_map or "map").upper()
        x, y, angle = get_player_position(game)
        cell_bucket = f"cell_{int(x // 64)}_{int(y // 64)}"
        angle_bucket = f"ang_{int((angle % 360) // 22.5)}"
        # Local geometry and revisitation distinguish a wall/door approach from
        # the same cell after a loop. Depth is observation, not privileged map data.
        depth = getattr(game_state, "depth_buffer", None)
        clearance = "unknown"
        if depth is not None:
            h, w = depth.shape
            clearance = "_".join(str(min(3, int(float(depth[h//2, int(w*f)]) // 32))) for f in (.25, .5, .75))
        seen = min(2, self.episode_cells.get((map_bucket, cell_bucket), 0) // 8)
        return "|".join((STATE_KEY_VERSION, self.context, map_bucket, cell_bucket, angle_bucket, f"depth_{clearance}", f"seen_{seen}", target_bucket, distance_bucket, pickup_bucket, health_bucket, ammo_bucket, stuck_bucket))

    def choose(self, state_key: str, preferred: str | None = None) -> tuple[str, bool]:
        # Read-only selection: fresh evaluation must not create Q rows/visits.
        values = self.q.get(state_key, {})
        visits = self.visits.get(state_key, {})
        parts = state_key.split("|")
        if len(parts) > 4:
            cell = (parts[2], parts[3])
            self.episode_cells[cell] = self.episode_cells.get(cell, 0) + 1
        danger = "no_monster" not in parts or "critical_hp" in parts or "low_hp" in parts
        stuck = "stuck_high" in parts or "stuck_low" in parts
        if "no_monster" not in parts:
            pool = [preferred] if preferred in LEARNED_ACTIONS else ["retreat"]
            if preferred and preferred.startswith("attack"):
                pool += ["attack", "attack_strafe_left", "attack_strafe_right"]
        elif stuck:
            pool = ["door_probe", "unstuck_spin_scan", "turn_left", "turn_right", "strafe_left", "strafe_right"]
        else:
            pool = ["corridor_forward", "wall_follow_left", "wall_follow_right", "door_probe", "turn_left", "turn_right"]
            if preferred in LEARNED_ACTIONS: pool.append(preferred)
        pool = list(dict.fromkeys(pool))
        # Confidence belongs to the selected action, not total visits to a state.
        supported = [a for a in pool if visits.get(a, 0) >= self.q_takeover_min_visits]
        ranked = sorted(supported, key=lambda a: values.get(a, 0), reverse=True)
        best = ranked[0] if ranked else None
        spread = (values.get(best, 0) - max([values.get(a, 0) for a in pool if a != best], default=0)) if best else 0
        confident = best is not None and spread >= self.q_takeover_min_spread
        epsilon = self.epsilon * (0.15 if danger else 0.35 if confident else 1.0)
        if random.random() < epsilon:
            # Count-biased context-safe exploration, not uniform primitive spam.
            weights = [1 / math.sqrt(1 + visits.get(a, 0)) for a in pool]
            self.last_source = "exploration"
            return random.choices(pool, weights=weights)[0], True
        if confident:
            self.last_source = "q"
            return best, False
        # Reject repeatedly bad heuristic actions; use the best evidenced option
        # even when every action is negative (the old zero rows blocked takeover).
        if preferred in pool and visits.get(preferred, 0) >= self.q_takeover_min_visits and values.get(preferred, 0) < -0.2:
            self.last_source = "q_reject"
            return max(pool, key=lambda a: values.get(a, 0)), False
        self.last_source = "warmup"
        return preferred if preferred in pool else pool[0], False

    def update(self, state_key: str, action_name: str, reward: float, next_state_key: str, terminal: bool = False, elapsed_tics: int = 3) -> None:
        if not isinstance(elapsed_tics, int) or elapsed_tics <= 0:
            raise ValueError("transition duration must be a positive tic count")
        values = self.q.setdefault(state_key, {})
        next_values = self.q.setdefault(next_state_key, {})
        for name in LEARNED_ACTIONS:
            values.setdefault(name, 0.0)
            next_values.setdefault(name, 0.0)
        visits = self.visits.setdefault(state_key, {})
        for name in LEARNED_ACTIONS:
            visits.setdefault(name, 0)
        visits[action_name] = int(visits.get(action_name, 0)) + 1
        old = values[action_name]
        target = reward if terminal else reward + self.gamma ** elapsed_tics * max(next_values.values())
        values[action_name] = old + self.alpha * (target - old)
        self.steps += 1
        self._refresh_epsilon()
        self.save()

    def replay_episode(self, transitions: list[dict], completed: bool, map_name: str) -> None:
        # No invented near-success labels, no death replay, no double exit bonus.
        # Replay only a verified terminal success; rewards already contain exit.
        if not completed or not transitions or not transitions[-1].get("terminal"):
            return
        if any(not isinstance(t.get("tics", 3), int) or t.get("tics", 3) <= 0 for t in transitions):
            raise ValueError("invalid replay duration")
        return_so_far = 0.0
        replay_alpha = self.alpha * (1.35 if completed else 0.45)
        for transition in reversed(transitions):
            state_key = transition.get("state")
            action_name = transition.get("action")
            if state_key not in self.q or action_name not in LEARNED_ACTIONS:
                continue
            return_so_far = float(transition.get("reward", 0.0)) + self.gamma ** int(transition.get("tics", 3)) * return_so_far
            values = self.q.setdefault(state_key, {})
            for name in LEARNED_ACTIONS:
                values.setdefault(name, 0.0)
            values[action_name] = values[action_name] + replay_alpha * (return_so_far - values[action_name])
        if completed:
            self.save_successful_trajectory(transitions, map_name)
        self.save(force=True)

    def save_successful_trajectory(self, transitions: list[dict], map_name: str) -> None:
        compact = {
            "ts": time.time(),
            "map": str(map_name).upper(),
            "state_key_version": STATE_KEY_VERSION,
            "steps": len(transitions),
            "transitions": transitions,
        }
        try:
            with SUCCESS_TRAJECTORY_PATH.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(compact, sort_keys=True) + "\n")
        except Exception:
            pass

    def summary(self, limit: int = 20) -> dict:
        rows = []
        for state_key, values in self.q.items():
            if not isinstance(values, dict) or not values:
                continue
            best_action = max(values, key=values.get)
            rows.append(
                {
                    "state": state_key,
                    "best_action": best_action,
                    "best_value": round(float(values[best_action]), 4),
                    "actions": {name: round(float(value), 4) for name, value in sorted(values.items())},
                }
            )
        rows.sort(key=lambda row: abs(row["best_value"]), reverse=True)
        return {
            "steps": self.steps,
            "deaths": self.deaths,
            "schema_version": POLICY_SCHEMA_VERSION,
            "state_key_version": STATE_KEY_VERSION,
            "completions": dict(sorted(self.completions.items())),
            "states": len(self.q),
            "visited_state_actions": sum(sum(int(v) for v in actions.values()) for actions in self.visits.values()),
            "epsilon": self.epsilon,
            "alpha": self.alpha,
            "gamma": self.gamma,
            "policy_file": str(self.path),
            "top_states": rows[:limit],
        }


def learning_summary() -> dict:
    learner = OnlineDoomLearner(LEARNING_POLICY_PATH)
    summary = learner.summary()
    summary["objective"] = "Beat Doom shareware E1M1-E1M8 first, then improve toward 100% kills/items/secrets including E1M9."
    summary["reward_model"] = {
        "map_exit": "+100 and advance to next map",
        "new_exploration_cell": "+0.7",
        "kill": "+4.0",
        "item": "+1.2 plus extra health-restoration shaping when useful",
        "secret": "+8.0",
        "death": "-40.0 and restart same map (no fake advancement)",
        "stuck_or_not_moving": "negative shaping",
    }
    return summary


def apply_action_names(buttons: list[str], action_names: list[str], weapon: str = "auto", tick: int = 0) -> list[int]:
    action = [0] * len(buttons)
    for name in action_names:
        if name in buttons:
            action[buttons.index(name)] = 1
        elif name == "MOVE_LEFT" and "TURN_LEFT" in buttons:
            action[buttons.index("TURN_LEFT")] = 1
        elif name == "MOVE_RIGHT" and "TURN_RIGHT" in buttons:
            action[buttons.index("TURN_RIGHT")] = 1
    if weapon != "auto" and tick % 20 == 0 and f"SELECT_WEAPON{weapon}" in buttons:
        action[buttons.index(f"SELECT_WEAPON{weapon}")] = 1
    return action


def heuristic_action_name(game, game_state, tick: int, stuck_ticks: int) -> tuple[str, str]:
    health = int(game.get_game_variable(vzd.GameVariable.HEALTH))
    ammo = int(game.get_game_variable(vzd.GameVariable.SELECTED_WEAPON_AMMO))
    if stuck_ticks > 0:
        if stuck_ticks % 5 == 0:
            return "door_probe", "learning escape: probing door/wall"
        return "unstuck_spin_scan", "learning escape: macro scan"
    pickups = visible_health_pickups(game_state)
    if health < 45 and pickups:
        pickup = max(pickups, key=lambda label: label.width * label.height)
        offset = pickup.x + pickup.width / 2 - 160
        if offset < -20:
            return "forward_left", f"survival: moving toward {pickup.object_name} left"
        if offset > 20:
            return "forward_right", f"survival: moving toward {pickup.object_name} right"
        return "forward", f"survival: collecting {pickup.object_name}"
    monsters = [label for label in getattr(game_state, "labels", []) if label.object_category == "Monster"]
    if monsters:
        target = max(monsters, key=lambda label: label.width * label.height)
        offset = target.x + target.width / 2 - 160
        if ammo <= 0:
            return ("use_forward" if tick % 7 == 0 else "retreat", f"survival: no ammo near {target.object_name}")
        if health < 25:
            if abs(offset) < 24:
                return ("attack_retreat", f"survival: firing while retreating from {target.object_name}")
            return ("attack_back_left" if offset < 0 else "attack_back_right", f"survival: low-health firing dodge from {target.object_name}")
        if offset < -18:
            return "attack_forward_left", f"learning attack-track {target.object_name} left"
        if offset > 18:
            return "attack_forward_right", f"learning attack-track {target.object_name} right"
        if target.width < 42:
            return "attack_until_clear", f"learning engage {target.object_name}"
        return ("attack_strafe_left" if (tick // 12) % 2 == 0 else "attack_strafe_right", f"survival: circle-strafing {target.object_name}")
    if tick % 80 in (0, 1, 2):
        return "door_probe", "learning explore: trying door probe"
    if tick % 55 < 16:
        return ("wall_follow_left" if (tick // 140) % 2 == 0 else "wall_follow_right", "learning explore: wall-follow scan")
    return "corridor_forward", "learning explore: corridor advance"


def episode_won(game):
    timeout = game.get_episode_timeout() if hasattr(game, "get_episode_timeout") else 0
    clock = game.get_episode_time() if hasattr(game, "get_episode_time") else 0
    return game.is_episode_finished() and not game.is_player_dead() and not (timeout and clock >= timeout)


def learning_reward(
    raw_reward: float,
    moved: float,
    health_delta: float,
    stats_delta: dict,
    discovered_cell: bool,
    stuck_ticks: int,
    game,
) -> float:
    reward = float(raw_reward) * 0.05
    reward -= 0.01  # No perpetual positive reward for driving in circles.
    if discovered_cell:
        reward += 0.7
    reward += stats_delta.get("kills", 0) * 4.0
    reward += stats_delta.get("items", 0) * 1.2
    reward += stats_delta.get("secrets", 0) * 8.0
    # Turning/scanning is necessary navigation, not automatically a collision.
    if stuck_ticks > 0:
        reward -= 0.25
    if health_delta < 0:
        reward += health_delta * 0.18
    elif health_delta > 0:
        reward += min(health_delta, 50) * 0.08
    if game.is_player_dead():
        reward -= 40.0
    if episode_won(game):
        reward += 100.0
    return reward


def action_from_labels(game, game_state, tick: int, controls: dict, stuck_ticks: int) -> tuple[list[int], str]:
    buttons = [str(button).split(".")[-1] for button in game.get_available_buttons()]
    action = [0] * len(buttons)

    def press(name: str) -> None:
        if name in buttons:
            action[buttons.index(name)] = 1

    weapon = str(controls.get("weapon", "auto"))
    if weapon != "auto" and tick % 20 == 0:
        press(f"SELECT_WEAPON{weapon}")

    if stuck_ticks > 0:
        if stuck_ticks % 5 == 0:
            press("USE")
        if stuck_ticks > 10:
            press("MOVE_BACKWARD")
        else:
            press("MOVE_FORWARD")
        press("TURN_LEFT" if (tick // 18) % 2 == 0 else "TURN_RIGHT")
        return action, "escaping corner / trying door"

    monsters = [label for label in getattr(game_state, "labels", []) if label.object_category == "Monster"]
    if monsters:
        target = max(monsters, key=lambda label: label.width * label.height)
        target_center = target.x + target.width / 2
        screen_center = 160
        offset = target_center - screen_center

        if offset < -18:
            press("ATTACK")
            press("TURN_LEFT")
            press("MOVE_FORWARD")
            return action, f"firing while tracking {target.object_name} left"
        if offset > 18:
            press("ATTACK")
            press("TURN_RIGHT")
            press("MOVE_FORWARD")
            return action, f"firing while tracking {target.object_name} right"

        press("ATTACK")
        if target.width < 42:
            press("MOVE_FORWARD")
        return action, f"engaging {target.object_name}"

    press("MOVE_FORWARD")
    if tick % 45 < 10:
        press("TURN_LEFT" if (tick // 90) % 2 == 0 else "TURN_RIGHT")
    if tick % 80 in (0, 1, 2):
        press("USE")
    return action, "exploring level"


def execute_option(game, action, name, max_tics=None, return_tics=False):
    """Bounded feedback option: interrupt on damage, obstruction or terminal.

    USE is edge-triggered: release at the start of EVERY probe. A held USE
    across consecutive macros otherwise cannot reopen/probe a new door.
    """
    budget = ACTION_TICS.get(name, 3) if max_tics is None else max_tics
    buttons = [str(b).split(".")[-1] for b in game.get_available_buttons()]
    reward = 0.0
    hp = game.get_game_variable(vzd.GameVariable.HEALTH)
    elapsed = 0
    if name == "door_probe" and budget and not game.is_episode_finished():
        released = list(action)
        if "USE" in buttons: released[buttons.index("USE")] = 0
        reward += game.make_action(released, 1)
        elapsed += 1
    while elapsed < budget and not game.is_episode_finished():
        x, y, _ = get_player_position(game)
        n = min(2, budget - elapsed)
        for _ in range(n):
            if game.is_episode_finished(): break
            reward += game.make_action(action, 1)
            elapsed += 1
        if game.is_episode_finished(): break
        nx, ny, _ = get_player_position(game)
        if game.get_game_variable(vzd.GameVariable.HEALTH) < hp: break
        if name in ("corridor_forward", "attack_until_clear") and elapsed >= 4 and math.hypot(nx-x, ny-y) < 0.5: break
        if name == "attack_until_clear" and not any(l.object_category == "Monster" for l in game.get_state().labels): break
    return (reward, elapsed) if return_tics else reward


def start_game(controls: dict, map_name: str | None = None):
    game = vzd.DoomGame()
    scenario = controls.get("scenario", "deadly_corridor")
    scenario_config = SCENARIOS.get(scenario, SCENARIOS["doom_shareware_e1m1"])
    game.load_config(vzd.scenarios_path + "/" + scenario_config["config"])
    uses_shareware_iwad = scenario_config["config"] == "doom.cfg"
    if uses_shareware_iwad and DOOM_SHAREWARE_WAD.exists():
        game.set_doom_game_path(str(DOOM_SHAREWARE_WAD))
    target_map = (map_name or scenario_config.get("map")) if uses_shareware_iwad else None
    if target_map:
        game.set_doom_map(target_map)
    game.set_doom_skill(max(1, min(5, int(controls.get("difficulty", 3)))))
    game.set_render_hud(bool(controls.get("show_hud", True)))
    game.set_depth_buffer_enabled(True)
    game.set_labels_buffer_enabled(True)
    game.set_objects_info_enabled(True)
    try:
        game.add_available_game_variable(vzd.GameVariable.HEALTH)
        game.add_available_game_variable(vzd.GameVariable.POSITION_X)
        game.add_available_game_variable(vzd.GameVariable.POSITION_Y)
        game.add_available_game_variable(vzd.GameVariable.ANGLE)
        game.add_available_game_variable(vzd.GameVariable.SELECTED_WEAPON)
        game.add_available_game_variable(vzd.GameVariable.SELECTED_WEAPON_AMMO)
        game.add_available_game_variable(vzd.GameVariable.KILLCOUNT)
        game.add_available_game_variable(vzd.GameVariable.ITEMCOUNT)
        game.add_available_game_variable(vzd.GameVariable.SECRETCOUNT)
    except Exception:
        pass
    game.set_window_visible(False)
    game.set_mode(vzd.Mode.PLAYER)
    if "seed" in controls: game.set_seed(int(controls["seed"]))
    game.init()
    if controls.get("god_mode"):
        try:
            game.send_game_command("god")
            game.send_game_command("give ammo")
            game.send_game_command("give weapons")
        except Exception:
            pass
    if controls.get("idkfa"):
        try:
            game.send_game_command("idkfa")
            game.send_game_command("give all")
            game.send_game_command("give ammo")
            game.send_game_command("give weapons")
        except Exception:
            pass
    return game


def get_player_position(game) -> tuple[float, float, float]:
    try:
        return (
            float(game.get_game_variable(vzd.GameVariable.POSITION_X)),
            float(game.get_game_variable(vzd.GameVariable.POSITION_Y)),
            float(game.get_game_variable(vzd.GameVariable.ANGLE)),
        )
    except Exception:
        return (0.0, 0.0, 0.0)


def get_completion_stats(game) -> dict:
    def gv(variable):
        try:
            return int(game.get_game_variable(variable))
        except Exception:
            return 0

    return {
        "kills": gv(vzd.GameVariable.KILLCOUNT),
        "items": gv(vzd.GameVariable.ITEMCOUNT),
        "secrets": gv(vzd.GameVariable.SECRETCOUNT),
    }


def next_episode_map(current_map: str) -> str | None:
    try:
        index = SHAREWARE_EPISODE_MAPS.index(current_map.upper())
    except ValueError:
        return None
    if index + 1 >= len(SHAREWARE_EPISODE_MAPS):
        return None
    return SHAREWARE_EPISODE_MAPS[index + 1]


def run_demo_loop(state: DoomState) -> None:
    tick = 0
    while not state.stop:
        tick += 1
        frame = jpeg_placeholder("ViZDoom not installed; dashboard stream is ready.", tick)
        state.set_frame(
            frame,
            mode="demo",
            tick=tick,
            message="Install vizdoom to let Hermes play real Doom.",
        )
        time.sleep(0.12)


def run_vizdoom_loop(state: DoomState) -> None:
    if vzd is None or Image is None:
        run_demo_loop(state)
        return
    episode = 1
    tick = 0
    game = None
    revision = -1
    position_history: list[tuple[int, float, float]] = []
    stuck_ticks = 0
    learner = OnlineDoomLearner(LEARNING_POLICY_PATH)
    if state.controls.get("freeze_learning"): learner.epsilon = 0.0
    current_map = "E1M1"
    completed_maps: list[str] = []
    visited_cells: set[tuple[int, int, str]] = set()
    episode_transitions: list[dict] = []
    while not state.stop:
        controls = state.controls_snapshot()
        if game is None or controls["revision"] != revision:
            if game is not None:
                game.close()
            scenario_config = SCENARIOS.get(controls.get("scenario"), SCENARIOS["doom_shareware_episode"])
            if scenario_config["config"] == "doom.cfg":
                current_map = str(controls.get("map") or scenario_config.get("map") or "E1M1").upper()
            else:
                current_map = controls.get("scenario", "scenario")
            completed_maps = []
            visited_cells = set()
            episode_transitions = []
            learner.set_context(controls)
            game = start_game(controls, current_map if scenario_config["config"] == "doom.cfg" else None)
            revision = controls["revision"]
            episode = 1
            tick = 0
            position_history = []
            stuck_ticks = 0
            learner.reset_episode()
        controls = state.controls_snapshot()
        while not state.stop:
            if state.controls_snapshot()["revision"] != revision:
                break
            if state.consume_learning_reset():
                learner = OnlineDoomLearner(LEARNING_POLICY_PATH)
                learner.set_context(state.controls_snapshot())
                if state.controls.get("freeze_learning"): learner.epsilon = 0.0
            controls = state.controls_snapshot()
            if getattr(state, 'paused', False):
                time.sleep(0.05)
                continue
            if controls.get("god_mode") and game.is_player_dead():
                game.respawn_player()
                state.status["policy"] = "god mode respawn"
                time.sleep(0.1)
                continue
            if game.is_episode_finished():
                score = game.get_total_reward()
                finished_map = current_map
                if episode_transitions and not controls.get("freeze_learning"):
                    learner.replay_episode(episode_transitions, completed=episode_won(game), map_name=finished_map)
                    episode_transitions = []
                scenario_config = SCENARIOS.get(controls.get("scenario"), {})
                if not episode_won(game):
                    if game.is_player_dead() and not controls.get("freeze_learning"): learner.record_death()
                    if controls.get("auto_restart", True):
                        game.close()
                        game = start_game(controls, current_map if scenario_config.get("config") == "doom.cfg" else None)
                        learner.reset_episode()
                        visited_cells = set()
                        episode_transitions = []
                        position_history = []
                        stuck_ticks = 0
                        tick = 0
                        episode += 1
                        state.status["score"] = score
                        state.status["policy"] = f"death on {finished_map}; restarting same map"
                        continue
                    state.set_frame(
                        jpeg_placeholder(f"Died on {finished_map}. Press Restart Level.", tick, mode="vizdoom"),
                        mode="vizdoom",
                        tick=tick,
                        episode=episode,
                        score=score,
                        message=f"Died on {finished_map}.",
                        policy="waiting after death",
                        learning_deaths=learner.deaths,
                    )
                    time.sleep(0.25)
                    continue
                if episode_won(game) and finished_map not in completed_maps:
                    completed_maps.append(finished_map)
                    if not controls.get("freeze_learning"): learner.record_completion(finished_map)
                advance_map = next_episode_map(current_map) if scenario_config.get("episode") else None
                if advance_map:
                    game.close()
                    current_map = advance_map
                    controls["map"] = current_map
                    game = start_game(controls, current_map)
                    learner.reset_episode()
                    visited_cells = set()
                    episode_transitions = []
                    position_history = []
                    stuck_ticks = 0
                    tick = 0
                    episode += 1
                    state.status["score"] = score
                    continue
                episode += 1
                if controls.get("auto_restart", True):
                    game.new_episode()
                    learner.reset_episode()
                    visited_cells = set()
                    episode_transitions = []
                    position_history = []
                    stuck_ticks = 0
                    tick = 0
                    state.status["score"] = score
                else:
                    state.set_frame(
                        jpeg_placeholder("Episode finished. Press Restart Level.", tick, mode="vizdoom"),
                        mode="vizdoom",
                        tick=tick,
                        episode=episode,
                        score=score,
                        message="Episode finished.",
                        policy="waiting for restart",
                    )
                    time.sleep(0.25)
                    continue
            game_state = game.get_state()
            old_x, old_y, _ = get_player_position(game)
            old_health = game.get_game_variable(vzd.GameVariable.HEALTH)
            old_stats = get_completion_stats(game)
            learning_mode = bool(controls.get("self_improve"))
            learned_state_key = ""
            learned_action_name = ""
            explored = False
            if game_state:
                if learning_mode:
                    buttons = [str(button).split(".")[-1] for button in game.get_available_buttons()]
                    learned_state_key = learner.state_key(game, game_state, stuck_ticks, current_map)
                    preferred_action, preferred_policy = heuristic_action_name(game, game_state, tick, stuck_ticks)
                    learned_action_name, explored = learner.choose(learned_state_key, preferred_action)
                    if hasattr(state, 'select_action'):
                        learned_action_name = state.select_action(game, game_state, learned_action_name, stuck_ticks, current_map)
                        if state.paused:
                            continue
                    action = apply_action_names(buttons, LEARNED_ACTIONS[learned_action_name], str(controls.get("weapon", "auto")), tick)
                    policy = f"frozen policy / optional Jev: {learned_action_name}" + (" (explore)" if explored else f"; local heuristic: {preferred_policy}")
                else:
                    action, policy = action_from_labels(game, game_state, tick, controls, stuck_ticks)
                if not controls.get("aggressive", True) and "ATTACK" in [str(button).split(".")[-1] for button in game.get_available_buttons()]:
                    action[[str(button).split(".")[-1] for button in game.get_available_buttons()].index("ATTACK")] = 0
            else:
                action = [0] * len(game.get_available_buttons())
                policy = "waiting for state"
            action_tics = ACTION_TICS.get(learned_action_name, 3) if learned_action_name else 3
            reward, elapsed_tics = execute_option(game, action, learned_action_name, action_tics, return_tics=True)
            tick += 1
            if stuck_ticks > 0:
                stuck_ticks -= 1
            x, y, angle = get_player_position(game)
            moved = math.hypot(x - old_x, y - old_y)
            health = game.get_game_variable(vzd.GameVariable.HEALTH)
            stats = get_completion_stats(game)
            stats_delta = {key: stats[key] - old_stats.get(key, 0) for key in stats}
            cell = (int(x // 128), int(y // 128), current_map)
            discovered_cell = cell not in visited_cells
            visited_cells.add(cell)
            position_history.append((tick, x, y))
            position_history = position_history[-45:]
            if tick > 45 and tick % 12 == 0 and stuck_ticks == 0 and len(position_history) >= 30:
                _, old_x, old_y = position_history[-30]
                distance = math.hypot(x - old_x, y - old_y)
                if distance < 8:
                    stuck_ticks = 24
                    policy = "stuck detected; starting escape"
            if learning_mode and not controls.get("freeze_learning") and game_state and learned_state_key and learned_action_name:
                next_state = game.get_state()
                next_key = learner.state_key(game, next_state, stuck_ticks, current_map) if next_state else learned_state_key
                shaped_reward = learning_reward(reward, moved, health - old_health, stats_delta, discovered_cell, stuck_ticks, game)
                terminal = game.is_episode_finished()
                learner.update(learned_state_key, learned_action_name, shaped_reward, next_key, terminal=terminal, elapsed_tics=elapsed_tics)
                episode_transitions.append({
                    "state": learned_state_key,
                    "action": learned_action_name,
                    "reward": round(float(shaped_reward), 4),
                    "next_state": next_key,
                    "terminal": terminal,
                    "tics": elapsed_tics,
                })
                # Retain the full successful route for terminal credit assignment.
                if terminal:
                    learner.replay_episode(episode_transitions, completed=episode_won(game), map_name=current_map)
                    episode_transitions = []
            if game_state and game_state.screen_buffer is not None:
                frame = frame_from_vizdoom(game_state.screen_buffer)
            else:
                frame = jpeg_placeholder("Waiting for ViZDoom frame...", tick, mode="vizdoom")
            state.set_frame(
                frame,
                mode="vizdoom",
                tick=tick,
                episode=episode,
                reward=reward,
                score=game.get_total_reward(),
                message="Hermes is playing Doom.",
                policy=policy,
                self_improve=learning_mode,
                learning_steps=learner.steps,
                learning_states=len(learner.q),
                learning_epsilon=round(learner.epsilon, 4),
                learning_deaths=learner.deaths,
                learning_completions=learner.completions,
                learning_action=learned_action_name,
                learning_action_tics=elapsed_tics,
                learning_source=learner.last_source,
                learning_state_key=learned_state_key,
                learning_explored=explored,
                health=health,
                selected_weapon=game.get_game_variable(vzd.GameVariable.SELECTED_WEAPON),
                selected_weapon_ammo=game.get_game_variable(vzd.GameVariable.SELECTED_WEAPON_AMMO),
                position_x=round(x, 1),
                position_y=round(y, 1),
                angle=round(angle, 1),
                stuck_ticks=stuck_ticks,
                scenario=controls.get("scenario"),
                map_control=controls.get("map"),
                difficulty=controls.get("difficulty"),
                weapon=controls.get("weapon"),
                god_mode=controls.get("god_mode"),
                idkfa=controls.get("idkfa"),
                show_hud=controls.get("show_hud"),
                map=game.get_doom_map(),
                current_map=current_map,
                completed_maps=completed_maps,
                episode_goal="Beat Doom shareware E1M1-E1M8 first, then improve toward 100% kills/items/secrets including E1M9.",
                exploration_cells=len(visited_cells),
                kills=stats["kills"],
                items=stats["items"],
                secrets=stats["secrets"],
                wad=str(DOOM_SHAREWARE_WAD) if SCENARIOS.get(controls.get("scenario"), {}).get("config") == "doom.cfg" and DOOM_SHAREWARE_WAD.exists() else "ViZDoom scenario/default IWAD",
            )
            time.sleep(0.06)
    if game is not None:
        game.close()


def make_handler(state: DoomState):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def do_GET(self):  # noqa: N802
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(INDEX_HTML.encode("utf-8"))
                return
            if path == "/status.json":
                _, status = state.snapshot()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(status, sort_keys=True).encode("utf-8"))
                return
            if path == "/learning.json":
                body = json.dumps(learning_summary(), sort_keys=True).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/stream.mjpg":
                self.send_response(200)
                self.send_header("Age", "0")
                self.send_header("Cache-Control", "no-cache, private")
                self.send_header("Pragma", "no-cache")
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.end_headers()
                while not state.stop:
                    frame, _ = state.snapshot()
                    if frame:
                        try:
                            self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n")
                            self.wfile.flush()
                        except BrokenPipeError:
                            break
                    time.sleep(0.1)
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):  # noqa: N802
            path = urlparse(self.path).path
            if path != "/control":
                self.send_response(404)
                self.end_headers()
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except Exception:
                payload = {}
            controls = state.update_controls(payload)
            _, status = state.snapshot()
            body = json.dumps({"ok": True, "controls": controls, "status": status}, sort_keys=True).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


INDEX_HTML = """<!doctype html>
<html>
<head><meta charset="utf-8"><base href="/doom/"><title>Hermes Doom Watch</title>
<style>
*{box-sizing:border-box}html,body{min-height:100%;background:#050505}body{margin:0;color:#eee;font-family:system-ui,Arial,sans-serif;overflow-y:auto;-webkit-overflow-scrolling:touch}
main{min-height:100vh;min-height:100dvh;width:100vw;padding:.55rem;display:flex;flex-direction:column;gap:.4rem}.top{display:flex;justify-content:space-between;gap:1rem;align-items:center;flex-wrap:wrap;flex:0 0 auto}
h1{margin:0;color:#ff4545;font-size:1.15rem}.bar{display:flex;justify-content:space-between;gap:1rem;color:#aaa;font-size:.8rem;flex-wrap:wrap}
img{width:100%;height:auto;min-height:420px;flex:1 0 auto;object-fit:contain;border:2px solid #762020;border-radius:12px;background:#111;box-shadow:0 0 32px rgba(255,0,0,.18)}
code{color:#ffd080}.controls{display:flex;gap:.35rem;flex-wrap:wrap;align-items:center;padding:.45rem;border:1px solid #331515;border-radius:12px;background:#120808;flex:0 0 auto}
button,select,label{background:#1d1111;color:#eee;border:1px solid #5d2424;border-radius:8px;padding:.35rem .5rem;font-size:.78rem}button{cursor:pointer;background:#7a1d1d}button:hover{background:#982626}label{display:flex;gap:.25rem;align-items:center}.meta{color:#aaa;font-size:.8rem}
.learning-panel{display:none;max-height:28vh;overflow:auto;border:1px solid #331515;border-radius:10px;background:#0c0707;padding:.5rem;color:#ddd;font-size:.76rem;white-space:pre-wrap}.learning-panel.open{display:block}
@media(max-width:700px){
main{min-height:100dvh;padding:.35rem;gap:.25rem}
.top{gap:.35rem;flex-wrap:nowrap}.top h1{font-size:.95rem;white-space:nowrap}.meta{font-size:.68rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:54vw}
.controls{overflow-x:auto;overflow-y:hidden;flex-wrap:nowrap;padding:.3rem;gap:.28rem;-webkit-overflow-scrolling:touch;scrollbar-width:none}.controls::-webkit-scrollbar{display:none}
button,select,label{flex:0 0 auto;min-height:38px;font-size:.72rem;padding:.28rem .42rem;touch-action:manipulation}select{max-width:42vw}
.bar{font-size:.68rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}.bar span:last-child{display:none}
.learning-panel{position:absolute;left:.35rem;right:.35rem;top:5.3rem;z-index:3;max-height:42vh;background:rgba(12,7,7,.96)}
img{border-radius:8px;border-width:1px;min-height:calc(100dvh - 7.5rem);height:auto}
}
</style></head>
<body><main>
<div class="top"><h1>Hermes Doom Watch</h1><div class="meta" id="policy">loading policy...</div></div>
<div class="controls">
<button onclick="sendControl({restart:true})">Restart Level</button>
<select id="scenario" onchange="sendControl({scenario:this.value,restart:true})"></select>
<select id="map" onchange="sendControl({map:this.value,restart:true})"></select>
<button onclick="loadSelectedGame()">Load Selection</button>
<select id="difficulty" onchange="sendControl({difficulty:this.value,restart:true})">
<option value="1">Difficulty 1</option><option value="2">Difficulty 2</option><option value="3">Difficulty 3</option><option value="4">Difficulty 4</option><option value="5">Difficulty 5</option>
</select>
<select id="weapon" onchange="sendControl({weapon:this.value,restart:false})"></select>
<label><input id="god_mode" type="checkbox" onchange="sendControl({god_mode:this.checked,restart:true})"> God mode</label>
<label><input id="idkfa" type="checkbox" onchange="sendControl({idkfa:this.checked,restart:true})"> IDKFA</label>
<label><input id="show_hud" type="checkbox" onchange="sendControl({show_hud:this.checked,restart:true})" checked> HUD</label>
<label><input id="self_improve" type="checkbox" onchange="sendControl({self_improve:this.checked,restart:false})"> Self-improve</label>
<button onclick="toggleLearningData()">Learning Data</button>
<button onclick="sendControl({reset_learning:true,restart:true})">Reset Learning</button>
<label><input id="aggressive" type="checkbox" onchange="sendControl({aggressive:this.checked,restart:false})" checked> Attack</label>
<label><input id="auto_restart" type="checkbox" onchange="sendControl({auto_restart:this.checked,restart:false})" checked> Auto restart</label>
</div>
<div class="bar"><span id="status">connecting…</span><span><code>status.json</code> · <code>stream.mjpg</code></span></div>
<div id="learning-panel" class="learning-panel"></div>
<img src="stream.mjpg" alt="Hermes Doom stream">
</main>
<script>
let optionsLoaded=false;
function optionHtml(options){return Object.entries(options||{}).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}
function syncControls(s){const c=s.controls||{};if(!optionsLoaded){document.getElementById('scenario').innerHTML=optionHtml(s.scenarios);document.getElementById('map').innerHTML=optionHtml(s.maps);document.getElementById('weapon').innerHTML=optionHtml(s.weapons);optionsLoaded=true;}for(const id of ['scenario','map','difficulty','weapon']){if(c[id]!==undefined)document.getElementById(id).value=c[id];}for(const id of ['god_mode','idkfa','show_hud','self_improve','aggressive','auto_restart']){if(c[id]!==undefined)document.getElementById(id).checked=!!c[id];}}
async function sendControl(payload){await fetch('control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});setTimeout(poll,500);}
function loadSelectedGame(){sendControl({scenario:document.getElementById('scenario').value,map:document.getElementById('map').value,restart:true});}
async function toggleLearningData(){const panel=document.getElementById('learning-panel');panel.classList.toggle('open');if(!panel.classList.contains('open'))return;const r=await fetch('learning.json',{cache:'no-store'});const d=await r.json();const nl=String.fromCharCode(10);panel.textContent=`Objective: ${d.objective}${nl}Steps: ${d.steps} · States: ${d.states} · epsilon=${d.epsilon}${nl}Policy file: ${d.policy_file}${nl}${nl}Top learned states:${nl}`+(d.top_states||[]).slice(0,8).map(s=>`${s.state}${nl}  best: ${s.best_action} (${s.best_value})`).join(nl);}
async function poll(){try{const r=await fetch('status.json',{cache:'no-store'});const s=await r.json();syncControls(s);const learn=s.self_improve?` · learning=${s.learning_steps||0} steps/${s.learning_states||0} states`:'';document.getElementById('status').textContent=`${s.message||'running'} · ${s.current_map||s.map||''} · completed=${(s.completed_maps||[]).length}/9 · kills=${s.kills||0} items=${s.items||0} secrets=${s.secrets||0} · cells=${s.exploration_cells||0} · hp=${Math.round(s.health||0)}${learn}`;document.getElementById('policy').textContent=s.policy||s.episode_goal||'';}catch(e){document.getElementById('status').textContent='watch server not responding';}}
setInterval(poll,1000); poll();
</script></body></html>"""



def evaluate_e1m1(trials: int, max_steps: int, policy_path: Path = LEARNING_POLICY_PATH) -> dict:
    if vzd is None or Image is None:
        return {"ok": False, "error": "vizdoom and pillow are required for evaluation"}
    learner = OnlineDoomLearner(policy_path)
    saved_epsilon = learner.epsilon
    learner.epsilon = 0.0
    controls = {
        "scenario": "doom_shareware_e1m1",
        "map": "E1M1",
        "difficulty": 3,
        "weapon": "auto",
        "show_hud": False,
        "god_mode": False,
        "idkfa": False,
    }
    results = []
    for trial in range(1, trials + 1):
        learner = OnlineDoomLearner(policy_path)
        learner.epsilon = 0.0
        controls["seed"] = 100 + trial - 1
        game = start_game(controls, "E1M1")
        tick = 0
        stuck_ticks = 0
        position_history: list[tuple[int, float, float]] = []
        visited_cells: set[tuple[int, int, str]] = set()
        last_policy = ""
        try:
            while not game.is_episode_finished() and tick < max_steps:
                game_state = game.get_state()
                old_x, old_y, _ = get_player_position(game)
                if game_state:
                    buttons = [str(button).split(".")[-1] for button in game.get_available_buttons()]
                    state_key = learner.state_key(game, game_state, stuck_ticks, "E1M1")
                    preferred_action, preferred_policy = heuristic_action_name(game, game_state, tick, stuck_ticks)
                    action_name, explored = learner.choose(state_key, preferred_action)
                    action = apply_action_names(buttons, LEARNED_ACTIONS[action_name], "auto", tick)
                    last_policy = f"{action_name}; {preferred_policy}"
                else:
                    action_name = ""
                    action = [0] * len(game.get_available_buttons())
                    last_policy = "waiting for state"
                execute_option(game, action, action_name, ACTION_TICS.get(action_name, 3) if action_name else 3)
                tick += 1
                if stuck_ticks > 0:
                    stuck_ticks -= 1
                x, y, _ = get_player_position(game)
                visited_cells.add((int(x // 128), int(y // 128), "E1M1"))
                position_history.append((tick, x, y))
                position_history = position_history[-45:]
                if tick > 45 and tick % 12 == 0 and stuck_ticks == 0 and len(position_history) >= 30:
                    _, old_px, old_py = position_history[-30]
                    if math.hypot(x - old_px, y - old_py) < 8:
                        stuck_ticks = 24
            results.append({
                "trial": trial,
                "completed": bool(episode_won(game)),
                "dead": bool(game.is_player_dead()),
                "timeout": bool(not episode_won(game) and not game.is_player_dead()),
                "steps": tick,
                "cells": len(visited_cells),
                "score": float(game.get_total_reward()),
                "last_policy": last_policy,
            })
        finally:
            game.close()
    learner.epsilon = saved_epsilon
    wins = sum(1 for row in results if row["completed"])
    deaths = sum(1 for row in results if row["dead"])
    timeouts = sum(1 for row in results if row["timeout"])
    return {
        "ok": True,
        "trials": trials,
        "wins": wins,
        "deaths": deaths,
        "timeouts": timeouts,
        "win_rate": wins / trials if trials else 0.0,
        "policy_file": str(policy_path),
        "state_key_version": STATE_KEY_VERSION,
        "results": results,
    }

def main() -> int:
    global LEARNING_POLICY_PATH
    parser = argparse.ArgumentParser(description="Serve Hermes Doom watch stream")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9988)
    parser.add_argument("--evaluate-e1m1", type=int, default=0, metavar="TRIALS", help="run isolated no-learning E1M1 evaluation trials and print JSON")
    parser.add_argument("--eval-max-steps", type=int, default=2500, help="max decision steps per E1M1 evaluation trial")
    parser.add_argument("--policy", type=Path, default=LEARNING_POLICY_PATH)
    parser.add_argument("--no-learning", action="store_true", help="watch frozen Q policy without updates or exploration")
    args = parser.parse_args()
    LEARNING_POLICY_PATH = args.policy
    if args.evaluate_e1m1:
        print(json.dumps(evaluate_e1m1(args.evaluate_e1m1, args.eval_max_steps, args.policy), indent=2, sort_keys=True))
        return 0
    state = DoomState()
    state.controls["freeze_learning"] = args.no_learning
    runner = threading.Thread(target=run_vizdoom_loop if vzd is not None else run_demo_loop, args=(state,), daemon=True)
    runner.start()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    print(f"Hermes Doom watch server listening on http://{args.host}:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        state.stop = True
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
