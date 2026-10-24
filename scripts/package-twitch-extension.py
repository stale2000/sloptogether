import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ("index.html", "extension.css", "extension.js")
HELPER = "https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"


def package(output: Path) -> Path:
    source = ROOT / "apps" / "web" / "public" / "extension"
    files = {}
    for name in ASSETS:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"extension_asset_invalid:{name}")
        files[name] = path.read_bytes()

    html = files["index.html"].decode("utf-8")
    if "./extension.css" not in html or "./extension.js" not in html:
        raise ValueError("extension_assets_must_use_sibling_paths")
    if HELPER not in html or html.index(HELPER) > html.index("./extension.js"):
        raise ValueError("twitch_helper_must_load_before_extension_script")

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
    parser = argparse.ArgumentParser(description="Package the static Twitch Extension assets.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "sloptogether-twitch-extension.zip")
    args = parser.parse_args()
    try:
        output = package(args.output)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"Extension ZIP ready: {output} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
