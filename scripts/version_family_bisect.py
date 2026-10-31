# version_family_bisect.py — 版本头族 7 条二分定位（2026-11-01）
# 前置：header_bisect.py 已定案「版本族整组（无 UA）单独 3012」。本脚本在族内二分到单条。
# 方法：已证安全基座 + 候选池对半叠加，3012 ⇒ 扳机在前半；200 ⇒ 前半安全并入基座。
#       每发换一个 farm 号（账号变量隔离），非 405/3012 错误换号重试一次。定位后补一发确认。
import base64
import json
import os
import platform
import ssl
import sys
import time
import urllib.error
import urllib.request
import uuid
import winreg
from hashlib import sha256
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

HOME = Path.home()
SWITCH_DIR = HOME / ".zcode-switch"
UPSTREAM = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
MODEL = "GLM-5.3-Flash"
ASK = "1+1 等于几？只回数字"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def b64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def derive_key():
    plat = {"Windows": "win32", "Darwin": "darwin", "Linux": "linux"}[platform.system()]
    user = os.environ.get("USERNAME") or ""
    return sha256(f"zcode-credential-fallback:{plat}:{HOME}:{user}".encode()).digest()


KEY = derive_key()


def dec(v):
    if not (isinstance(v, str) and v.startswith("enc:v1:")):
        return v
    iv, tag, ct = (b64u(x) for x in v[len("enc:v1:"):].split("."))
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(KEY).decrypt(iv, ct + tag, None).decode("utf-8", "replace")


def jwt_exp(jwt):
    try:
        return int(json.loads(b64u(jwt.split(".")[1])).get("exp", 0))
    except Exception:
        return 0


def zcode_app_version():
    for hive in [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]:
        try:
            k = winreg.OpenKey(hive[0], hive[1])
        except OSError:
            continue
        with k:
            for i in range(winreg.QueryInfoKey(k)[0]):
                try:
                    sub = winreg.OpenKey(k, winreg.EnumKey(k, i))
                except OSError:
                    continue
                with sub:
                    try:
                        name, _ = winreg.QueryValueEx(sub, "DisplayName")
                        ver, _ = winreg.QueryValueEx(sub, "DisplayVersion")
                    except OSError:
                        continue
                    l = str(name).lower()
                    if "zcode" in l and "switch" not in l:
                        parts = str(ver).split(".")
                        return ".".join(parts[:3]) if len(parts) >= 3 else str(ver)
    return "3.17.1"


def os_version():
    try:
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        with k:
            build, _ = winreg.QueryValueEx(k, "CurrentBuildNumber")
        return f"10.0.{build}"
    except OSError:
        return None


def farm_members():
    out = []
    for f in sorted(SWITCH_DIR.glob("accounts/*.json")):
        if ".bak" in f.name:
            continue
        try:
            acc = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        jwt = dec(acc.get("credentials", {}).get("zcodejwttoken", "") or "")
        if not jwt or len(jwt) < 20:
            continue
        exp = jwt_exp(jwt)
        if exp and exp < time.time():
            continue
        out.append({"id": acc["id"], "name": acc.get("name", acc["id"]), "token": jwt})
    return out


def build_body():
    prefix = json.loads(
        (Path(__file__).resolve().parent.parent / "src-tauri/src/gateway/assets/prefix.json")
        .read_text(encoding="utf-8")
    )["system_prefix"]
    system = [{"type": "text", "text": t, "cache_control": {"type": "ephemeral"}} for t in prefix]
    uid = json.dumps({"device_id": str(uuid.uuid4()), "account_uuid": "", "session_id": ""})
    return {
        "model": MODEL,
        "messages": [{"role": "user", "content": ASK}],
        "max_tokens": 512,
        "stream": True,
        "system": system,
        "metadata": {"user_id": uid},
    }


def fire(acc, extra, payload):
    h = {"Authorization": f"Bearer {acc['token']}", "Content-Type": "application/json"}
    for k, v in extra:
        h[k] = v
    req = urllib.request.Request(UPSTREAM, method="POST", data=payload, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=120, context=ctx) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:200]
    except Exception as e:
        return 0, str(e)


def main():
    ver = zcode_app_version()
    members = iter(farm_members())
    payload = json.dumps(build_body()).encode()

    # 候选池：按嫌疑度排序（版本自述最强的排最前）
    pool = [
        ("X-ZCode-App-Version", ver),
        ("X-Platform", "win32-x64"),
        ("X-Release-Channel", "stable"),
        ("X-Os-Category", "windows"),
        ("X-Os-Version", os_version() or ""),
        ("X-Client-Language", "zh-CN"),
        ("X-Client-Timezone", "Asia/Shanghai"),
    ]
    pool = [(k, v) for k, v in pool if v]

    def shoot(extra):
        while True:
            acc = next(members)
            st, raw = fire(acc, extra, payload)
            if st in (0, 401, 429, 500, 502, 503):  # 账号个体/网络问题，换号重试
                print(f"  (跳过 {acc['name']}: HTTP {st}，换号重试)")
                continue
            return acc, st, raw

    base = []          # 已证安全
    guilty = pool      # 候选
    log = []
    while len(guilty) > 1:
        half, rest = guilty[: len(guilty) // 2], guilty[len(guilty) // 2:]
        acc, st, raw = shoot(base + half)
        names = "+".join(k for k, _ in half)
        print(f"[二分] base({len(base)}条) + ({names}) @ {acc['name']}: HTTP {st}")
        log.append(f"{names} -> {st}")
        if st in (3012, 405):
            guilty = half
        elif st == 200:
            base += half
            guilty = rest
        else:
            print(f"意外状态 {st}: {raw[:160]}")
            return 1
        time.sleep(2)

    # 单条确认：base + 嫌疑条 应 3012；再打一发 base 本身（应 200）作同轮对照
    acc, st, raw = shoot(base + guilty)
    print(f"[确认] base + ({guilty[0][0]}) @ {acc['name']}: HTTP {st}")
    log.append(f"confirm {guilty[0][0]} -> {st}")
    acc2, st2, raw2 = shoot(base)
    print(f"[对照] base({len(base)}条) @ {acc2['name']}: HTTP {st2}")
    log.append(f"base-only -> {st2}")

    print("\n=== 结论 ===")
    if st in (3012, 405) and st2 == 200:
        print(f"扳机 = {guilty[0][0]}（单条实锤：base+它 3012，同轮 base 200）")
    elif st in (3012, 405) and st2 in (3012, 405):
        print(f"{guilty[0][0]} 仍 3012 但 base 也 3012——多扳机联合或时点性，单条归因不成立")
    elif st == 200:
        print(f"{guilty[0][0]} 单独不触发（200）——整组 3012 为多条联合效应")
    (Path(__file__).parent / "version_family_bisect_results.txt").write_text(
        "# version_family_bisect 2026-11-01\n" + "\n".join(log), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
