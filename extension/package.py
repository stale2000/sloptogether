import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ("panel.html", "mobile.html", "video_component.html", "video_overlay.html", "config.html", "extension.css", "panel.js", "config.js", "bits-state.mjs", "figtree-latin.woff2")
HELPER = "https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"
SURFACE_VIEWS = (
    ("mobile.html", "mobile", "mobile panel"),
    ("video_component.html", "video-component", "video component"),
    ("video_overlay.html", "video-overlay", "video overlay"),
)

SOURCE_FILES = {
    "panel.html": ROOT / "extension" / "public" / "panel.html",
    "config.html": ROOT / "extension" / "public" / "config.html",
    "extension.css": ROOT / "extension" / "public" / "extension.css",
    "figtree-latin.woff2": ROOT / "extension" / "public" / "figtree-latin.woff2",
    "panel.js": ROOT / "extension" / "src" / "panel.js",
    "config.js": ROOT / "extension" / "src" / "config.js",
    "bits-state.mjs": ROOT / "extension" / "src" / "bits-state.mjs",
}


def package(output: Path) -> Path:
    source = ROOT / "extension"
    files = {}
    source_assets = tuple(name for name in ASSETS if name not in {view[0] for view in SURFACE_VIEWS})
    for name in source_assets:
        path = SOURCE_FILES[name]
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"extension_asset_invalid:{name}")
        files[name] = path.read_bytes()

    panel_html = files["panel.html"].decode("utf-8")
    for name, surface, title in SURFACE_VIEWS:
        files[name] = panel_html.replace(
            'data-theme="dark"', f'data-theme="dark" data-surface="{surface}"'
        ).replace(
            "<title>SlopTogether scene vote</title>", f"<title>SlopTogether {title}</title>"
        ).encode("utf-8")

    pages = (("panel.html", "./panel.js"), ("config.html", "./config.js")) + tuple(
        (name, "./panel.js") for name, _, _ in SURFACE_VIEWS
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
        for name in ASSETS:
            archive.writestr(name, files[name])

    with ZipFile(output) as archive:
        if archive.namelist() != list(ASSETS):
            raise ValueError("extension_archive_asset_set_invalid")
        for name in ASSETS:
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
