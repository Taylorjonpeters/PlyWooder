# PlyWooder

**Try it: https://taylorjonpeters.github.io/PlyWooder/**

Drop in a STEP or DXF file. PlyWooder lays the flat parts out on plywood sheets and exports DXF, SVG and G-code. Built to be compatible with the GORDIX CNC. Vibe-coded.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL and drop a `.step`, `.stp` or `.dxf` file on the page.

## More

[Full documentation](docs/DOCUMENTATION.md) covers every feature, the G-code dialects and the tests.

## License

MIT. See [LICENSE](LICENSE).

Built with [three.js](https://threejs.org), [Clipper](https://sourceforge.net/projects/jsclipper/) and [occt-import-js](https://github.com/kovacsv/occt-import-js). Files open in your browser and are never uploaded.

GORDIX support follows [GORDIX Studio](https://github.com/pfsin555/Gordix-studio) (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). PlyWooder is not affiliated with GORDIX or cubiio.
