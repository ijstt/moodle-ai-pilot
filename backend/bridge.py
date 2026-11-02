#!/usr/bin/env python3
"""
Moodle AI Pilot - Local Multimodal Bridge Server.
Bridges browser userscript DOM events with LLM reasoning, Whisper STT, and Vision APIs.
"""

import argparse
import http.server
import json
import os
import re
import socketserver
import urllib.request
import urllib.error
from typing import Dict, Any, List

from audio import transcribe_audio_base64
from vision import format_multimodal_message

DEFAULT_PORT = 8765

TEXT_MODELS = [
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-super-vl:free",
    "dots-studio/dots-3-note-preview:free",
    "cohere/north-mini-code:free",
]

VISION_MODELS = [
    "nvidia/nemotron-3.5-super-vl:free",
    "dots-studio/dots-3-note-preview:free",
]


def query_llm(messages: List[Dict[str, Any]], is_vision: bool = False) -> Dict[str, Any]:
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    ollama_url = os.environ.get("OLLAMA_BASE_URL", "")

    # 1. Local Ollama Provider if configured
    if ollama_url:
        payload = {
            "model": os.environ.get("OLLAMA_MODEL", "llama3.2"),
            "messages": messages,
            "stream": False,
            "format": "json"
        }
        req = urllib.request.Request(
            f"{ollama_url.rstrip('/')}/api/chat",
            headers={"Content-Type": "application/json"},
            data=json.dumps(payload).encode("utf-8")
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return json.loads(data["message"]["content"])

    # 2. OpenAI Direct Provider if configured
    if openai_key and not api_key:
        model = "gpt-4o-mini"
        headers = {
            "Authorization": f"Bearer {openai_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.1,
            "response_format": {"type": "json_object"}
        }
        req = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            data=json.dumps(payload).encode("utf-8")
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            return json.loads(res["choices"][0]["message"]["content"])

    # 3. OpenRouter Provider (Default / Free candidate pool)
    models = VISION_MODELS if is_vision else TEXT_MODELS
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }

    last_error = None
    for model in models:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.1
        }
        try:
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                data=json.dumps(payload).encode("utf-8")
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                text = res["choices"][0]["message"]["content"].strip()
                if text.startswith("```"):
                    text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
                    text = re.sub(r"\n?```$", "", text).strip()
                return json.loads(text)
        except Exception as e:
            last_error = e
            continue

    raise RuntimeError(f"All model providers failed. Last error: {last_error}")


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    def _set_headers(self, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(200)

    def do_GET(self):
        if self.path == "/health":
            self._set_headers(200)
            self.wfile.write(json.dumps({"status": "running"}).encode("utf-8"))
        else:
            self._set_headers(404)
            self.wfile.write(b"{}")

    def do_POST(self):
        if self.path != "/solve":
            self._set_headers(404)
            return

        content_length = int(self.headers.get("Content-Length", 0))
        post_data = self.rfile.read(content_length)

        try:
            req_json = json.loads(post_data.decode("utf-8"))
            questions = req_json.get("questions", [])

            system_instruction = (
                "You are an expert academic tutor solving university tests in Moodle LMS.\n"
                "Strict Rules:\n"
                "1. High accuracy based on the academic context of the question.\n"
                "2. For language questions: use standard straight apostrophe ' in contracted forms (haven't, hasn't, didn't, 've, 's).\n"
                "3. For Drag & Drop / Matching tasks: return an array containing the exact text or label of the matching item for each slot in order.\n"
                "4. Output ONLY a valid JSON object without markdown formatting, code fences or explanations."
            )

            prompt_text = (
                "Solve these Moodle questions.\n"
                "Return a JSON object mapping the question_number (as string) to the exact answer.\n\n"
                "- If a question has 1 text blank: map to a string, e.g. \"1\": \"have eaten\".\n"
                "- If a question has multiple blanks [BLANK_1], [BLANK_2]: map to an array of strings in order, e.g. \"2\": [\"has\", \"won\"].\n"
                "- If a question has drop targets [DROP_1], [DROP_2], ...: map to an array of matching choices in order.\n"
                "- If a question is multiple choice: map to the exact text of the correct choice.\n"
                "- If a question is a select dropdown: map to the exact text of the matching option.\n\n"
                "Questions list:\n"
            )

            has_images = False
            image_urls = []

            for q in questions:
                q_num = q.get("question_number")
                q_text = q.get("text", "")
                q_type = q.get("type", "")
                opts = q.get("options", [])
                sels = q.get("selects", [])
                drags = q.get("drag_choices", [])
                audios = q.get("audios", [])
                images = q.get("images", [])

                for aud in audios:
                    transcription = transcribe_audio_base64(aud)
                    if transcription:
                        q_text += f"\n\n[FULL AUDIO RECORDING TRANSCRIPT]:\n\"{transcription}\"\n"

                prompt_text += f"\n--- Question {q_num} (Type: {q_type}) ---\n"
                prompt_text += f"Text:\n{q_text}\n"

                if opts:
                    prompt_text += "Options:\n"
                    for o in opts:
                        prompt_text += f" - {o.get('text')}\n"

                if sels:
                    for s in sels:
                        s_idx = s.get("index", 0) + 1
                        opt_texts = [o.get("text") for o in s.get("options", [])]
                        prompt_text += f"Dropdown {s_idx} options: {opt_texts}\n"

                if drags:
                    prompt_text += "Available draggable choices to match with slots:\n"
                    for d in drags:
                        prompt_text += f" - {d.get('text')}\n"

                if images:
                    has_images = True
                    for img in images:
                        image_urls.append(img)

            if has_images:
                user_content = format_multimodal_message(prompt_text, image_urls)
                messages = [
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": user_content}
                ]
                answers = query_llm(messages, is_vision=True)
            else:
                messages = [
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": prompt_text}
                ]
                answers = query_llm(messages, is_vision=False)

            self._set_headers(200)
            self.wfile.write(json.dumps({"status": "ok", "answers": answers}).encode("utf-8"))

        except Exception as e:
            self._set_headers(500)
            self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))

    def log_message(self, format, *args):
        pass


def run_server(host: str = "127.0.0.1", port: int = DEFAULT_PORT):
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((host, port), BridgeHandler) as httpd:
        print(f"Moodle AI Pilot Bridge running on http://{host}:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down bridge server.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Moodle AI Pilot Bridge Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port number (default: 8765)")
    args = parser.parse_args()

    run_server(host=args.host, port=args.port)
