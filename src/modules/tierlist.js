"use strict";

// Joseki tier list, in the style of Tiermaker. The user lays out a joseki on the board and clicks one
// of the tier labels, which stores the current position in that tier. Along with it we store the line
// leading to it, as SGF, including every node's properties (comments, markup, etc) but not any other
// branches. Each entry is shown as an icon of the board, cropped to the area where stones are.
//
// The data is stored in its own file (not config.json) in the user data folder. It is also embedded
// in saved SGF files, without extending the format: each entry is appended to the file as a separate
// game tree (SGF collections are standard) whose root has GN[Ogatak Joseki Tier: <key>]. Loading such
// a file replaces the tier list with those entries, rather than opening them as games.
//
// Interactions:   click tier label  -->  add the current position to that tier
//                 click icon        -->  go to the joseki in the current game (or a new tab if incompatible)
//                 drag icon         -->  move to another tier / reorder
//                 right-click icon  -->  delete

const fs = require("fs");
const path = require("path");

const load_sgf = require("./load_sgf");
const new_node = require("./node");
const {tree_string} = require("./save_sgf");
const {translate} = require("./translate");
const {handicap_stones} = require("./utils");

const TIERS = [								// Tiermaker's default colours.
	{key: "S", colour: "#ff7f7fff"},
	{key: "A", colour: "#ffbf7fff"},
	{key: "B", colour: "#ffdf7fff"},
	{key: "C", colour: "#ffff7fff"},
	{key: "D", colour: "#bfff7fff"},
	{key: "U", colour: "#c8c8c8ff", label: translate("TIER_UNRANKED")},
];

// When following a stored line through nodes that already exist in the current game, these are
// the properties we copy over (only if the node doesn't already have them)...

const ANNOTATION_KEYS = [
	"C", "N", "LB", "TR", "CR", "SQ", "MA", "SL", "AR", "LN", "DD",
	"GB", "GW", "DM", "UC", "HO", "V", "TE", "BM", "DO", "IT",
];

const FILENAME = "joseki_tierlist.json";
const TIER_GN_PREFIX = "Ogatak Joseki Tier: ";

const ICON_CELL = 20;						// Pixels per intersection in the icon canvas (it gets scaled down by CSS).
const MIN_CROP = 7;							// Minimum number of lines shown in each direction (if the board allows).
const EDGE_SNAP = 3;						// If the cropped area gets this close to an edge, extend it to the edge.

function init() {

	let ret = Object.assign(Object.create(tierlist_prototype), {
		outer_div: document.getElementById("tierlist"),
		filepath: path.join(global.user_data_path, FILENAME),
		tiers: Object.create(null),			// key --> array of entries
		icon_cache: Object.create(null),	// entry id --> data URL
		row_divs: Object.create(null),		// key --> div that holds the icons
		dragged_id: null,
		next_id: 1,
	});

	for (let tier of TIERS) {
		ret.tiers[tier.key] = [];
	}

	ret.load();
	ret.build_dom();
	ret.apply_visibility();
	ret.draw();

	return ret;
}

let tierlist_prototype = {

	// Persistence.................................................................................

	load: function() {
		try {
			if (fs.existsSync(this.filepath)) {
				let o = JSON.parse(fs.readFileSync(this.filepath, "UTF-8"));
				for (let tier of TIERS) {
					if (o.tiers && Array.isArray(o.tiers[tier.key])) {
						this.tiers[tier.key] = o.tiers[tier.key].filter(entry => valid_entry(entry));
					}
				}
			}
		} catch (err) {
			console.log(`While loading ${FILENAME}:`);
			console.log(err.toString());
			this.load_failed = true;			// Don't overwrite the user's file with an empty list.
		}
		for (let entry of this.all_entries()) {
			this.next_id = Math.max(this.next_id, entry.id + 1);
		}
	},

	save: function() {
		if (this.load_failed) {
			return;
		}
		let o = {version: 1, tiers: this.tiers};
		try {
			fs.writeFileSync(this.filepath, JSON.stringify(o, null, "\t"));
		} catch (err) {
			console.log(err.toString());
		}
	},

	all_entries: function() {
		return TIERS.map(tier => this.tiers[tier.key]).flat();
	},

	find: function(id) {								// Returns [tier key, index] or null.
		for (let tier of TIERS) {
			let i = this.tiers[tier.key].findIndex(entry => entry.id === id);
			if (i !== -1) {
				return [tier.key, i];
			}
		}
		return null;
	},

	// Adding / moving / deleting..................................................................

	add_current: function(key) {

		let entry = make_entry(hub.node, this.next_id);

		if (!entry) {
			return;
		}

		// If this exact position is already registered, update its line (comments etc might have changed) and move it...

		for (let old of this.all_entries()) {
			if (old.width === entry.width && old.height === entry.height && old.stones === entry.stones) {
				old.moves = entry.moves;
				old.sgf = entry.sgf;
				this.move(old.id, key, null);		// Saves.
				return;
			}
		}

		this.next_id++;
		this.tiers[key].push(entry);
		this.save();
		this.draw();

		let icon = this.row_divs[key].lastChild;	// Make sure the new icon is visible.
		if (icon) {
			icon.scrollIntoView({block: "nearest"});
		}
	},

	move: function(id, key, before_id) {			// before_id === null means "at the end"
		if (id === before_id) {
			return;
		}
		let found = this.find(id);
		if (!found) {
			return;
		}
		let [old_key, i] = found;
		let entry = this.tiers[old_key].splice(i, 1)[0];
		let arr = this.tiers[key];
		let j = before_id === null ? -1 : arr.findIndex(o => o.id === before_id);
		if (j === -1) {
			arr.push(entry);
		} else {
			arr.splice(j, 0, entry);
		}
		this.save();
		this.draw();
	},

	delete: function(id) {
		let found = this.find(id);
		if (!found) {
			return;
		}
		let [key, i] = found;
		this.tiers[key].splice(i, 1);
		delete this.icon_cache[id];
		this.save();
		this.draw();
	},

	open: function(id) {
		let found = this.find(id);
		if (!found) {
			return;
		}
		let entry = this.tiers[found[0]][found[1]];

		// Parse the stored line. If its starting position matches the current game's, follow (or create)
		// that line in the current game. Otherwise there's nothing for it but to open a new tab...

		let roots = load_sgf(Buffer.from(entry.sgf), true).get_roots();
		if (roots.length === 0) {
			return;
		}
		let line_root = roots[0];
		let root = hub.node.get_root();

		let a = line_root.get_board();
		let b = root.get_board();

		if (a.width !== b.width || a.height !== b.height || board_string(a) !== board_string(b)) {
			line_root.destroy_tree();
			hub.load_sgf_from_string(entry.sgf);
			hub.go_to_end();						// In case config.load_at_end is false.
			return;
		}

		// Follow the line, creating nodes as needed. New nodes get all the stored properties, while existing
		// nodes only get annotations they don't already have (so we never overwrite the user's own)...

		copy_props(line_root, root, ANNOTATION_KEYS);

		let node = root;

		for (let line_node = line_root.children[0]; line_node; line_node = line_node.children[0]) {
			let key = line_node.has_key("B") ? "B" : (line_node.has_key("W") ? "W" : null);
			if (!key) {
				continue;
			}
			let s = line_node.get(key);
			let next = node.children.find(child => child.has_key_value(key, s));
			if (next) {
				copy_props(line_node, next, ANNOTATION_KEYS);
			} else {
				next = new_node(node);
				copy_props(line_node, next, null);
			}
			node = next;
		}

		line_root.destroy_tree();

		hub.set_node(node, {bless: true});
		tree_drawer.must_draw = true;				// In case nodes were created.
		comment_drawer.draw(hub.node);				// In case annotations were added to the node we were already on.
		hub.draw();
	},

	// SGF embedding...............................................................................

	export_strings: function() {					// One SGF game tree string per entry, in order.
		let ret = [];
		for (let tier of TIERS) {
			for (let entry of this.tiers[tier.key]) {
				let roots = load_sgf(Buffer.from(entry.sgf), true).get_roots();
				if (roots.length === 0) {
					continue;
				}
				roots[0].set("GN", TIER_GN_PREFIX + tier.key);
				ret.push(tree_string(roots[0]));
				roots[0].destroy_tree();
			}
		}
		return ret;
	},

	is_tier_root: function(root) {
		return root.has_key("GN") && root.get("GN").startsWith(TIER_GN_PREFIX);
	},

	import_roots: function(roots) {					// Replaces the whole tier list. Destroys the roots.
		for (let tier of TIERS) {
			this.tiers[tier.key] = [];
		}
		this.icon_cache = Object.create(null);
		for (let root of roots) {
			let key = root.get("GN").slice(TIER_GN_PREFIX.length).trim();
			if (this.tiers[key]) {
				root.delete_key("GN");
				let entry = make_entry(root.get_end(), this.next_id);
				if (entry) {
					this.next_id++;
					this.tiers[key].push(entry);
				}
			}
			root.destroy_tree();
		}
		this.save();
		this.draw();
	},

	// Display.....................................................................................

	apply_visibility: function() {
		this.outer_div.style["display"] = config.tierlist_visible ? "block" : "none";
	},

	build_dom: function() {

		// The tier rows...

		let table = document.createElement("div");
		table.className = "tier_table";

		for (let tier of TIERS) {

			let row = document.createElement("div");
			row.className = "tier_row";

			let label = document.createElement("div");
			label.className = "tier_label";
			label.textContent = tier.label || tier.key;
			if (tier.label) {
				label.classList.add("tier_label_text");
			}
			label.style["background-color"] = tier.colour;
			label.addEventListener("click", () => {
				this.add_current(tier.key);
			});
			row.appendChild(label);

			let items = document.createElement("div");
			items.className = "tier_items";
			this.add_drop_handlers(items, tier.key);
			row.appendChild(items);

			table.appendChild(row);
			this.row_divs[tier.key] = items;
		}

		this.outer_div.appendChild(table);
	},

	draw: function() {
		for (let tier of TIERS) {
			let items = this.row_divs[tier.key];
			items.replaceChildren();
			for (let entry of this.tiers[tier.key]) {
				items.appendChild(this.make_icon(entry));
			}
		}
	},

	make_icon: function(entry) {

		if (!this.icon_cache[entry.id]) {
			this.icon_cache[entry.id] = draw_icon(entry);
		}

		let img = document.createElement("img");
		img.className = "tier_icon";
		img.src = this.icon_cache[entry.id];
		img.draggable = true;
		img.dataset.id = entry.id.toString();

		img.addEventListener("click", () => {
			this.open(entry.id);
		});
		img.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.delete(entry.id);
		});
		img.addEventListener("dragstart", (event) => {
			this.dragged_id = entry.id;
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("text/plain", "");		// Some browsers want something set.
			img.classList.add("tier_dragging");
		});
		img.addEventListener("dragend", () => {
			this.dragged_id = null;
			img.classList.remove("tier_dragging");
			this.clear_drop_markers();
		});

		return img;
	},

	add_drop_handlers: function(items, key) {

		items.addEventListener("dragover", (event) => {
			if (this.dragged_id === null) {
				return;
			}
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			this.clear_drop_markers();
			let target = event.target.closest(".tier_icon");
			if (target) {
				target.classList.add("tier_drop_before");
			} else {
				items.classList.add("tier_drop_end");
			}
		});

		items.addEventListener("dragleave", (event) => {
			if (!items.contains(event.relatedTarget)) {
				this.clear_drop_markers();
			}
		});

		items.addEventListener("drop", (event) => {
			if (this.dragged_id === null) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();				// Don't let the window's file-drop handler see it.
			let target = event.target.closest(".tier_icon");
			let before_id = target ? parseInt(target.dataset.id, 10) : null;
			let id = this.dragged_id;
			this.dragged_id = null;
			this.clear_drop_markers();
			this.move(id, key, before_id);
		});
	},

	clear_drop_markers: function() {
		for (let el of this.outer_div.querySelectorAll(".tier_drop_before, .tier_drop_end")) {
			el.classList.remove("tier_drop_before", "tier_drop_end");
		}
	},
};

// ------------------------------------------------------------------------------------------------

function valid_entry(entry) {
	return entry && typeof entry === "object" &&
		typeof entry.id === "number" &&
		typeof entry.width === "number" && typeof entry.height === "number" &&
		typeof entry.stones === "string" && entry.stones.length === entry.width * entry.height &&
		typeof entry.sgf === "string";
}

function board_string(board) {						// Row-major, "." for empty.
	let list = [];
	for (let y = 0; y < board.height; y++) {
		for (let x = 0; x < board.width; x++) {
			list.push(board.state[x][y] || ".");
		}
	}
	return list.join("");
}

function make_entry(node, id) {					// Returns null if there are no stones.
	let board = node.get_board();
	let stones = board_string(board);
	if (!stones.includes("b") && !stones.includes("w")) {
		return null;
	}
	return {
		id: id,
		width: board.width,
		height: board.height,
		stones: stones,
		moves: node.history().reduce((n, o) => n + o.move_count(), 0),
		sgf: line_sgf(node),
		added: new Date().toISOString(),
	};
}

function line_sgf(node) {							// SGF of just the line from the root to the node, with all their properties.
	return "(" + node.history().map(n => n.string()).join("") + ")";
}

function copy_props(src, dest, keys) {				// keys === null means all keys. Keys dest already has are left alone.
	for (let key of src.all_keys()) {
		if ((keys && !keys.includes(key)) || dest.has_key(key)) {
			continue;
		}
		for (let value of src.all_values(key)) {
			dest.add_value(key, value);
		}
	}
}

function crop_rect(entry) {

	let {width, height, stones} = entry;

	let x1 = width, y1 = height, x2 = -1, y2 = -1;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (stones[y * width + x] !== ".") {
				x1 = Math.min(x1, x); x2 = Math.max(x2, x);
				y1 = Math.min(y1, y); y2 = Math.max(y2, y);
			}
		}
	}

	// A margin of 1 line, and snap to edges that are close...

	x1 = Math.max(0, x1 - 1); y1 = Math.max(0, y1 - 1);
	x2 = Math.min(width - 1, x2 + 1); y2 = Math.min(height - 1, y2 + 1);

	if (x1 <= EDGE_SNAP) x1 = 0;
	if (y1 <= EDGE_SNAP) y1 = 0;
	if (x2 >= width - 1 - EDGE_SNAP) x2 = width - 1;
	if (y2 >= height - 1 - EDGE_SNAP) y2 = height - 1;

	// Ensure a minimum size, and an aspect ratio of at most 2:1, growing away from the edges...

	let w = x2 - x1 + 1;
	let h = y2 - y1 + 1;

	[x1, x2] = grow(x1, x2, Math.min(width, Math.max(MIN_CROP, w, Math.ceil(h / 2))), width);
	[y1, y2] = grow(y1, y2, Math.min(height, Math.max(MIN_CROP, h, Math.ceil(w / 2))), height);

	return {x1, y1, x2, y2};
}

function grow(lo, hi, want, size) {				// Expand [lo, hi] to the wanted length, growing away from edges.
	let toggle = false;
	while (hi - lo + 1 < want) {				// Terminates since want <= size.
		if (lo === 0) {
			hi++;
		} else if (hi === size - 1) {
			lo--;
		} else if ((toggle = !toggle)) {
			hi++;
		} else {
			lo--;
		}
	}
	return [lo, hi];
}

function draw_icon(entry) {

	let {width, height, stones} = entry;
	let {x1, y1, x2, y2} = crop_rect(entry);

	let cols = x2 - x1 + 1;
	let rows = y2 - y1 + 1;
	let s = ICON_CELL;

	let c = document.createElement("canvas");
	c.width = cols * s;
	c.height = rows * s;

	let ctx = c.getContext("2d");

	ctx.fillStyle = config.wood_colour;
	ctx.fillRect(0, 0, c.width, c.height);

	let gx = x => (x - x1) * s + s / 2;
	let gy = y => (y - y1) * s + s / 2;

	// Grid lines: at real edges they stop at the edge line, otherwise they run off the icon to show the board continues...

	ctx.strokeStyle = "#000000ff";
	ctx.lineWidth = 1;
	ctx.beginPath();

	let left = x1 === 0 ? gx(0) : 0;
	let right = x2 === width - 1 ? gx(width - 1) : c.width;
	let top = y1 === 0 ? gy(0) : 0;
	let bottom = y2 === height - 1 ? gy(height - 1) : c.height;

	for (let x = x1; x <= x2; x++) {
		ctx.moveTo(Math.floor(gx(x)) + 0.5, top);
		ctx.lineTo(Math.floor(gx(x)) + 0.5, bottom);
	}
	for (let y = y1; y <= y2; y++) {
		ctx.moveTo(left, Math.floor(gy(y)) + 0.5);
		ctx.lineTo(right, Math.floor(gy(y)) + 0.5);
	}
	ctx.stroke();

	// Edge lines a little thicker...

	ctx.lineWidth = 2;
	ctx.beginPath();
	if (x1 === 0) { ctx.moveTo(gx(0), top); ctx.lineTo(gx(0), bottom); }
	if (x2 === width - 1) { ctx.moveTo(gx(width - 1), top); ctx.lineTo(gx(width - 1), bottom); }
	if (y1 === 0) { ctx.moveTo(left, gy(0)); ctx.lineTo(right, gy(0)); }
	if (y2 === height - 1) { ctx.moveTo(left, gy(height - 1)); ctx.lineTo(right, gy(height - 1)); }
	ctx.stroke();

	// Hoshi...

	ctx.fillStyle = "#000000ff";
	for (let p of handicap_stones(Math.min(width, height) > 13 ? 9 : 5, width, height, false)) {
		let x = p.charCodeAt(0) - 97;
		let y = p.charCodeAt(1) - 97;
		if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
			ctx.beginPath();
			ctx.arc(gx(x), gy(y), s * 0.12, 0, 2 * Math.PI);
			ctx.fill();
		}
	}

	// Stones...

	let r = s * 0.47;

	for (let y = y1; y <= y2; y++) {
		for (let x = x1; x <= x2; x++) {
			let colour = stones[y * width + x];
			if (colour !== "b" && colour !== "w") {
				continue;
			}
			let grad = ctx.createRadialGradient(gx(x) - r * 0.35, gy(y) - r * 0.35, r * 0.1, gx(x), gy(y), r);
			if (colour === "b") {
				grad.addColorStop(0, "#555555ff");
				grad.addColorStop(1, "#000000ff");
			} else {
				grad.addColorStop(0, "#ffffffff");
				grad.addColorStop(1, "#c8c8c8ff");
			}
			ctx.fillStyle = grad;
			ctx.beginPath();
			ctx.arc(gx(x), gy(y), r, 0, 2 * Math.PI);
			ctx.fill();
			if (colour === "w") {
				ctx.strokeStyle = "#00000080";
				ctx.lineWidth = 1;
				ctx.stroke();
			}
		}
	}

	return c.toDataURL("image/png");
}



module.exports = init();
