"""Test-only runner for the unchanged upstream Store snapshot. Not shipped to users."""
import importlib.util
import json
import os
from pathlib import Path
import sys
sys.dont_write_bytecode = True

# Upstream uses POSIX fcntl. Use a one-byte Windows lock only for these sequential
# compatibility tests; this does not claim interoperation with a live POSIX writer.
if os.name == "nt":
    import msvcrt
    import types

    def flock(fd, operation):
        offset = os.lseek(fd, 0, os.SEEK_CUR)
        if os.fstat(fd).st_size == 0:
            os.write(fd, b"\0")
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK if operation == 8 else msvcrt.LK_LOCK, 1)
        os.lseek(fd, offset, os.SEEK_SET)

    sys.modules["fcntl"] = types.SimpleNamespace(flock=flock, LOCK_EX=1, LOCK_UN=8)

spec = importlib.util.spec_from_file_location("sapper_reference", Path(__file__).with_name("sapper_store.py"))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)
reference.now_iso = lambda: "2026-11-03T00:00:00Z"
action, directory = sys.argv[1:3]
store = reference.Store(Path(directory))

if action == "seed":
    store.init("Python golden fixture", "验证 TS 与 Python 往返")
    host = store.add_fact("本地测试主机", "python", title="Local fixture", kind="host", data={"host": "127.0.0.1", "port": 80, "tls": False})
    intent = store.add_intent([host["id"]], "读取本地 fixture", "python", requires_confirmation=True, doc="planning evidence")
    store.confirm_intent(intent["id"])
    store.claim_intent(intent["id"], "python-explore")
    store.add_fact("fixture 服务已确认", "python-explore", source_intent=intent["id"], kind="service", doc="原始响应\n证据第二行")
    store.add_hint("已有证据，避免重复探测", "python")
    store.add_fact("golden flag", "python", kind="flag", data={"value": "flag{GOLDEN}", "status": "recorded", "challenge": "local"})
    with store.locked():
        project = store.load_project()
        project["upstream_extension"] = {"preserve": True}
        store.save_project(project)
        host["extension"] = {"nested": [1, 2, 3]}
        reference.atomic_write_json(store.facts_dir / (host["id"] + ".json"), host)
elif action == "append":
    assert reference.validate_graph(store) == []
    service = next(f for f in store.list_facts() if f.get("title") == "TS service")
    store.update_doc(service["id"], "Python edited TS document", expected_doc=service.get("doc"))
    store.update_flag_fact("f003", "rejected", "Python lifecycle update")
    store.add_fact("Python wrote after TS", "python", kind="note")
    store.add_hint("Python round trip complete", "python")
elif action == "frontier":
    store.add_intent(["f001"], "ordinary open task", "python")
    store.add_intent(["f001"], "pending confirmation", "python", requires_confirmation=True)
    claimed = store.add_intent(["f002"], "claimed task", "python")
    store.claim_intent(claimed["id"], "python-worker")
    confirmed = store.add_intent(["f002"], "confirmed task", "python", requires_confirmation=True)
    store.confirm_intent(confirmed["id"])
elif action != "inspect":
    raise ValueError("unknown action")

errors = reference.validate_graph(store)
assert errors == [], errors
view = reference.build_graph_view(store)
view["reference_frontier"] = reference.frontier(store)
view["reference_history"] = reference.render_history_block(store)
print(json.dumps(view, ensure_ascii=True))
