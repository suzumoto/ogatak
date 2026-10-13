"use strict";

// Autosave of the open tabs -- every game tree in full, the current node of each, and the file info --
// so that the app reopens in the state it was left in. Saved periodically (only when changed) and on
// quit, restored at startup. The joseki tier list has its own file (see tierlist.js).

const fs = require("fs");
const path = require("path");

const load_sgf = require("./load_sgf");
const {tree_string} = require("./save_sgf");

const FILENAME = "session.json";

const filepath = path.join(global.user_data_path, FILENAME);

let last_saved = null;

function node_path(node) {							// Child indices from the root to the node.
	let ret = [];
	while (node.parent) {
		ret.push(node.parent.children.indexOf(node));
		node = node.parent;
	}
	return ret.reverse();
}

function follow_path(root, arr) {
	let node = root;
	for (let i of arr) {
		if (!node.children[i]) {
			break;
		}
		node = node.children[i];
	}
	return node;
}

exports.save = function() {

	let nodes = tabber.tab_node_list(hub.node);

	let o = {
		version: 1,
		active: tabber.active_index(),
		tabs: nodes.map(node => {
			let root = node.get_root();
			return {
				sgf: tree_string(node),
				path: node_path(node),
				filepath: root.filepath || "",
				save_ok: Boolean(root.save_ok),
			};
		}),
	};

	let s = JSON.stringify(o);

	if (s === last_saved) {
		return;
	}

	try {
		fs.writeFileSync(filepath, s);
		last_saved = s;
	} catch (err) {
		console.log(err.toString());
	}
};

exports.restore = function() {				// Expects to be called at startup, while there's a single bare tab.

	let o;

	try {
		if (!fs.existsSync(filepath)) {
			return;
		}
		o = JSON.parse(fs.readFileSync(filepath, "UTF-8"));
	} catch (err) {
		console.log(`While loading ${FILENAME}:`);
		console.log(err.toString());
		return;
	}

	if (!o || !Array.isArray(o.tabs)) {
		return;
	}

	let roots = [];
	let targets = [];
	let active = 0;

	for (let n = 0; n < o.tabs.length; n++) {
		let tab = o.tabs[n];
		if (!tab || typeof tab.sgf !== "string") {
			continue;
		}
		let r = load_sgf(Buffer.from(tab.sgf), true).get_roots();
		if (r.length === 0) {
			continue;
		}
		if (n === o.active) {
			active = roots.length;
		}
		r[0].filepath = typeof tab.filepath === "string" ? tab.filepath : "";
		r[0].save_ok = Boolean(tab.save_ok);
		roots.push(r[0]);
		targets.push(follow_path(r[0], Array.isArray(tab.path) ? tab.path : []));
	}

	if (roots.length === 0) {
		return;
	}

	// The bare tab gets replaced by the first root, the others become new tabs, and the last one is
	// made active. So tab indices match our arrays. Now put each tab on its saved node...

	hub.add_roots(roots);

	let current = tabber.active_index();
	hub.set_node(targets[current]);

	for (let n = 0; n < targets.length; n++) {
		if (n !== current) {
			tabber.tabs[n] = targets[n];			// Inactive tabs simply hold their node.
		}
	}

	if (active !== current) {
		hub.switch_tab_by_dom_id(tabber.dom_ids[active]);
	}

	tabber.draw_everything(hub.node);				// Thumbnails, since we changed the inactive tabs' nodes.
};
