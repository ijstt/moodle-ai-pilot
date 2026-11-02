"""
Vision Processing Module for Moodle AI Pilot.
Formats base64 images for Multimodal LLM APIs.
"""

from typing import List, Dict, Any


def format_multimodal_message(prompt: str, images_b64: List[str], max_images: int = 4) -> List[Dict[str, Any]]:
    """
    Constructs OpenAI/OpenRouter vision-compatible content blocks.
    """
    content = [{"type": "text", "text": prompt}]

    for img in images_b64[:max_images]:
        if not img:
            continue
        if img.startswith("data:") or img.startswith("http://") or img.startswith("https://"):
            url_val = img
        else:
            url_val = f"data:image/jpeg;base64,{img}"
        content.append({
            "type": "image_url",
            "image_url": {"url": url_val}
        })

    return content
