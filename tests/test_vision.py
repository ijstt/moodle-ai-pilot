import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend")))

from vision import format_multimodal_message


def test_format_multimodal_message_text_and_images():
    prompt = "Select the correct image"
    images = ["https://example.com/img1.png", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg"]

    res = format_multimodal_message(prompt, images)

    assert isinstance(res, list)
    assert len(res) == 3
    assert res[0] == {"type": "text", "text": prompt}
    assert res[1] == {"type": "image_url", "image_url": {"url": "https://example.com/img1.png"}}
    assert res[2] == {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg"}}


def test_format_multimodal_message_empty_images():
    prompt = "Only text question"
    res = format_multimodal_message(prompt, [])

    assert isinstance(res, list)
    assert len(res) == 1
    assert res[0] == {"type": "text", "text": prompt}
