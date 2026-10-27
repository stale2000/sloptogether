import argparse
import base64
import json
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
HELPER = "https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"


def package(output: Path) -> Path:
    source = ROOT / "extension"
    try:
        result = subprocess.run(
            ["node", str(source / "build.mjs"), "--package-json"],
            check=True, capture_output=True, text=True,
        )
    except subprocess.CalledProcessError as error:
        raise ValueError(f"extension_asset_generation_failed: {error.stderr.strip()}") from error
    generated = json.loads(result.stdout)
    files = {name: base64.b64decode(data, validate=True) for name, data in generated["files"].items()}
    assets = tuple(files)
    pages = (("config.html", "./config.js"),) + tuple(
        (name, "./panel.js") for name in generated["viewerPages"]
    )
    for page, script in pages:
        html = files[page].decode("utf-8")
        if "./extension.css" not in html or script not in html:
            raise ValueError(f"extension_assets_must_use_sibling_paths:{page}")
        if HELPER not in html or html.index(HELPER) > html.index(script):
            raise ValueError(f"twitch_helper_must_load_before_extension_script:{page}")
    if b'from "./bits-state.mjs"' not in files["panel.js"]:
        raise ValueError("extension_bits_state_module_missing")

    output = output.expanduser()
    source = source.resolve()
    if output.is_symlink():
        raise ValueError("extension_output_symlink_rejected")
    output = output.resolve()
    if output == source or source in output.parents:
        raise ValueError("extension_output_inside_source_directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name in assets:
            archive.writestr(name, files[name])

    with ZipFile(output) as archive:
        if archive.namelist() != list(assets):
            raise ValueError("extension_archive_asset_set_invalid")
        for name in assets:
            if archive.read(name) != files[name]:
                raise ValueError(f"extension_archive_asset_mismatch:{name}")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Package the isolated Twitch Extension assets.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "sloptogether-twitch-extension.zip")
    args = parser.parse_args()
    try:
        output = package(args.output)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"Extension ZIP ready: {output} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
