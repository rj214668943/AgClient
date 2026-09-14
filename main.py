# main.py
import os, sys, json, uuid, time
import webview
import requests

def get_resource_path(p):
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, p)
    return os.path.join(os.path.abspath("."), p)

CFG_DIR = os.path.join(os.path.expanduser("~"), ".agnes_canvas")
CFG_PATH = os.path.join(CFG_DIR, "config.json")
PROJ_PATH = os.path.join(CFG_DIR, "projects.json")

DEFAULT_CFG = {
    "api_base": "https://apihub.agnes-ai.com/v1",
    "api_key": "",
    "model_text": "",
    "model_image": "",
    "model_video": ""
}

def _load(path, default):
    os.makedirs(CFG_DIR, exist_ok=True)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return default

def _save(path, data):
    os.makedirs(CFG_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

config = _load(CFG_PATH, DEFAULT_CFG.copy())
for k, v in DEFAULT_CFG.items():
    config.setdefault(k, v)

def projects():
    return _load(PROJ_PATH, [])

def save_projects(p):
    _save(PROJ_PATH, p)

def _headers():
    return {
        "Authorization": f"Bearer {config['api_key']}",
        "Content-Type": "application/json"
    }

def _friendly_err(e):
    msg = str(e)
    if "401" in msg or "Unauthorized" in msg:
        return "API Key 无效或未授权，请检查设置"
    if "404" in msg:
        return "接口路径不存在，请检查 API Base URL 是否正确"
    if "429" in msg:
        return "请求过于频繁，请稍后重试"
    if "Connection" in msg or "Max retries" in msg or "timed out" in msg.lower():
        return "网络连接失败，请检查网络或 API Base URL"
    if "500" in msg or "502" in msg or "503" in msg:
        return "服务器错误，请稍后重试"
    return msg

class Api:
    def get_config(self):
        return config

    def save_config(self, cfg):
        for k in ("api_base", "api_key", "model_text", "model_image", "model_video"):
            if k in cfg:
                config[k] = str(cfg[k]).strip()
        _save(CFG_PATH, config)
        return {"status": "success"}

    # ---------- 诊断连接 ----------
    def diagnose(self):
        if not config.get("api_key"):
            return {"status": "error", "message": "API Key 为空"}

        base = config["api_base"].rstrip("/")
        key = config["api_key"]
        info = {
            "api_base_raw": config["api_base"],
            "api_base_final": base,
            "key_length": len(key),
            "key_prefix": key[:8] if len(key) > 8 else key,
            "key_suffix": key[-4:] if len(key) > 4 else "",
            "key_has_space": (" " in key or "\n" in key or "\t" in key or "\r" in key),
            "url_to_try": base + "/models"
        }

        try:
            r = requests.get(base + "/models", headers=_headers(), timeout=15)
            info["http_status"] = r.status_code
            info["response_preview"] = r.text[:800]
            if r.status_code == 200:
                info["result"] = "✅ 接口连通，Key 有效"
            elif r.status_code == 401:
                info["result"] = "❌ 401 未授权：Key 错误、过期，或认证 header 格式不对"
            elif r.status_code == 404:
                info["result"] = "❌ 404 路径错误：API Base URL 可能不对（末尾必须是 /v1）"
            else:
                info["result"] = f"❌ HTTP {r.status_code}"
        except Exception as e:
            info["result"] = "❌ 请求异常：" + str(e)
            info["http_status"] = None
            info["response_preview"] = None

        try:
            r2 = requests.get(base + "/models",
                              headers={"x-api-key": key, "Content-Type": "application/json"},
                              timeout=15)
            info["xapikey_status"] = r2.status_code
            info["xapikey_preview"] = r2.text[:300]
        except Exception as e:
            info["xapikey_status"] = "异常"
            info["xapikey_preview"] = str(e)

        return {"status": "success", "info": info}

    # ---------- 拉取模型 ----------
    def list_models(self):
        if not config.get("api_key"):
            return {"status": "error", "message": "请先设置 API Key"}
        url = config["api_base"].rstrip("/") + "/models"
        try:
            r = requests.get(url, headers=_headers(), timeout=20)
            r.raise_for_status()
            res = r.json()
            items = res.get("data") or res.get("models") or res
            if isinstance(items, dict):
                items = list(items.values())
            ids = []
            for m in items:
                if isinstance(m, dict):
                    mid = m.get("id") or m.get("name") or m.get("model")
                    if mid:
                        ids.append(mid)
                elif isinstance(m, str):
                    ids.append(m)
            ids.sort()
            return {"status": "success", "models": ids}
        except Exception as e:
            return {"status": "error", "message": _friendly_err(e)}

    # ---------- 项目 ----------
    def get_projects(self, module):
        ps = [p for p in projects() if p.get("type") == module]
        ps.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
        return ps

    def create_project(self, module, name):
        ps = projects()
        now = time.time()
        np = {"id": str(uuid.uuid4()), "type": module, "name": name,
              "data": {}, "created_at": now, "updated_at": now}
        ps.append(np)
        save_projects(ps)
        return {"status": "success", "project": np}

    def save_project_data(self, pid, data, name=None):
        ps = projects()
        for p in ps:
            if p["id"] == pid:
                p["data"] = data
                p["updated_at"] = time.time()
                if name:
                    p["name"] = name
                break
        save_projects(ps)
        return {"status": "success"}

    def get_project_data(self, pid):
        for p in projects():
            if p["id"] == pid:
                return {"status": "success", "project": p}
        return {"status": "error", "message": "not found"}

    def delete_project(self, pid):
        save_projects([p for p in projects() if p["id"] != pid])
        return {"status": "success"}

    # ---------- 文本 ----------
    def text_chat(self, messages, images=None, model=None, temperature=0.7, max_tokens=4096):
        if not config.get("api_key"):
            return {"status": "error", "message": "请先设置 API Key"}
        url = config["api_base"].rstrip("/") + "/chat/completions"
        use_model = model or config.get("model_text") or "agnes-3.0-flash"

        if images:
            for msg in reversed(messages):
                if msg["role"] == "user":
                    content_parts = [{"type": "text", "text": msg["content"]}]
                    for img in images:
                        content_parts.append({"type": "image_url", "image_url": {"url": img}})
                    msg["content"] = content_parts
                    break

        payload = {
            "model": use_model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False
        }
        try:
            r = requests.post(url, headers=_headers(), json=payload, timeout=180)
            r.raise_for_status()
            res = r.json()
            content = res["choices"][0]["message"]["content"]
            return {"status": "success", "content": content}
        except Exception as e:
            return {"status": "error", "message": _friendly_err(e)}

    # ---------- 图片 ----------
    def generate_image(self, prompt, size="2K", ratio="1:1", images=None, model=None):
        if not config.get("api_key"):
            return {"status": "error", "message": "请先设置 API Key"}
        url = config["api_base"].rstrip("/") + "/images/generations"
        use_model = model or config.get("model_image") or "agnes-image-2.5-flash"
        payload = {"model": use_model, "prompt": prompt, "size": size, "ratio": ratio}
        if images:
            payload["image"] = images
        try:
            r = requests.post(url, headers=_headers(), json=payload, timeout=600)
            r.raise_for_status()
            res = r.json()
            data = res.get("data") or []
            if not data:
                return {"status": "error", "message": "接口未返回图片"}
            item = data[0]
            out = item.get("url")
            b64 = item.get("b64_json")
            if not out and b64:
                out = "data:image/png;base64," + b64
            return {"status": "success", "url": out}
        except Exception as e:
            return {"status": "error", "message": _friendly_err(e)}

    # ---------- 视频 ----------
    def create_video_task(self, prompt, mode="text", size="720P",
                          aspect_ratio="16:9", seconds="5", images=None, model=None):
        if not config.get("api_key"):
            return {"status": "error", "message": "请先设置 API Key"}
        url = config["api_base"].rstrip("/") + "/videos"
        use_model = model or config.get("model_video") or "agnes-video-2.5-flash"
        payload = {
            "model": use_model,
            "prompt": prompt,
            "mode": mode,
            "size": size,
            "aspect_ratio": aspect_ratio,
            "seconds": seconds
        }
        if images:
            payload["images"] = images
        try:
            r = requests.post(url, headers=_headers(), json=payload, timeout=120)
            r.raise_for_status()
            return {"status": "success", "raw": r.json()}
        except Exception as e:
            return {"status": "error", "message": _friendly_err(e)}

    def wait_video(self, video_id, model=None):
        url = config["api_base"].rstrip("/") + "/agnesapi"
        use_model = model or config.get("model_video") or "agnes-video-2.5-flash"
        params = {"video_id": video_id, "model_name": use_model}
        start = time.time()
        while time.time() - start < 600:
            try:
                r = requests.get(url, headers=_headers(), params=params, timeout=60)
                r.raise_for_status()
                res = r.json()
                st = res.get("status") or res.get("state") or "unknown"
                if st in ("completed", "succeeded", "success"):
                    out = res.get("url") or res.get("video_url")
                    if not out and isinstance(res.get("output"), dict):
                        out = res["output"].get("url")
                    return {"status": "success", "url": out, "raw": res}
                if st in ("failed", "error", "canceled", "cancelled"):
                    return {"status": "error", "message": json.dumps(res, ensure_ascii=False)}
            except Exception as e:
                return {"status": "error", "message": _friendly_err(e)}
            time.sleep(2)
        return {"status": "error", "message": "视频生成超时"}

if __name__ == '__main__':
    api = Api()
    webview.create_window('Agnes AI 创作平台', get_resource_path('index.html'),
                          js_api=api, width=1400, height=900)
    webview.start()
