"use strict";

/**
 * Create a new wind-rose.
 *
 * Options are:
 *
 *   id                         a unique ID for this wind-rose (default: id of SVG, creating it if necessary)
 *   lag                        lag between anemometer readings and movement in ms (default: 4000)
 *   arc                        arc size for wind direction in degrees (default: 20)
 *   units                      units for values (default: "m/s");
 *   radius                     max radius to draw (default: one less than half of smaller viewBox dimension)
 *   cx                         position in SVG to center circle (default: half of horizontal viewBox)
 *   cy                         position in SVG to center circle (default: half of vertical viewBox)
 *   key                        DOM element to update with key (default: none, meaning one is created inside the SVG)
 *   max_data_count             the maximum number of anemometer readings to keep before discarding (default: 0 for none)
 *   max_data_age               the maximum age of an anemometer reading in seconds to keep before discarding (default: 0 for none)
 *   freq_step                  the gap between frequency bands to draw on the SVG in percent (default: 5)
 *   freq_min                   the minimum frequency band to draw to (default: 0)
 *   freq_max                   the maximum frequency band to draw to (default: 100)
 *   minbands                   the minimum number of bands to create in the key (default: 3)
 *
 * @param svg the SVG element to draw on
 * @param options the options, which 
 */
class WindRose {

    #MAXSPEED = 200;
    #SVGNS = "http://www.w3.org/2000/svg";
    #ball;
    #ballText;
    #freqsteps;
    #preloading;
    rose;               // the rose 2D array
    bands;              // the bands array containing the upper-bound of each speed band
    rose0;              // same as an entry in the rose array, but for speed=0
    svg;                // the target SVG
    options;            // the options
    q = [];             // the queue of events

    constructor(svg, options) {
        this.svg = svg;
        this.svg.classList.add("wind-rose");
        if (!this.svg.viewBox.baseVal || this.svg.viewBox.baseVal.width * this.svg.viewBox.baseVal.height == 0) {
            svg.setAttribute("viewBox", "0 0 " + this.svg.clientWidth+" " + this.svg.clientHeight);
        }

        this.options = options || {};
        if (typeof this.options.id != "string" || this.options.id.length == 0) {
            this.options.id = this.svg.id;
            if (typeof this.options.id != "string" || this.options.id.length == 0) {
                this.options.id = "wind-rose-" + Math.round(Math.random() * 1000000);
                this.svg.id = this.options.id;
            }
        }
        if (!(this.options.minbands >= 1)) {
            this.options.minbands = 3;
        }
        if (!(this.options.max_data_count >= 0)) {
            this.options.max_data_count = 0;
        }
        if (!(this.options.freq_step >= 0)) {
            this.options.freq_step = 5;
        }
        if (!(this.options.freq_max >= 0)) {
            this.options.freq_max = 100;
        }
        if (!(this.options.freq_min >= 0)) {
            this.options.freq_min = 0;
        }
        if (!(this.options.lag >= 0)) {
            this.options.lag = 4000;
        }
        if (!(this.options.arc > 0)) {
            this.options.arc = 20;
        }
        if (!(this.options.units)) {
            this.options.units = "m/s";
        }
        let numarcs = Math.ceil(360 / this.options.arc);
        this.options.arc = 360 / numarcs;

        if (typeof this.options.cx != "number") {
            this.options.cx = (this.svg.viewBox.baseVal.x + this.svg.viewBox.baseVal.width) / 2;
        }
        if (typeof this.options.cy != "number") {
            this.options.cy = (this.svg.viewBox.baseVal.y + this.svg.viewBox.baseVal.height) / 2;
        }
        if (!(this.options.radius > 0)) {
            this.options.radius = Math.max(10, (Math.min(this.svg.viewBox.baseVal.width, this.svg.viewBox.baseVal.height) / 2) - 1);
        }

        let g = document.createElementNS(this.#SVGNS, "g");
        this.svg.appendChild(g);
        g.setAttribute("transform", "translate(" + this.options.cx + "," + this.options.cy + ")");

        let scale = document.createElementNS(this.#SVGNS, "g");
        scale.classList.add("scale");
        g.appendChild(scale);
        let wind = document.createElementNS(this.#SVGNS, "g");
        wind.classList.add("wind");
        g.appendChild(wind);
        let ball = document.createElementNS(this.#SVGNS, "g");
        ball.classList.add("ball");
        g.appendChild(ball);
        this.#ball = ball;
        let ballCircle = document.createElementNS(this.#SVGNS, "circle");
        ball.appendChild(ballCircle);
        let ballText = document.createElementNS(this.#SVGNS, "text");
        ball.appendChild(ballText);
        this.#ballText = ballText;

        this.rose0 = {count:0};
        this.rose = [];
        for (let i=0;i<numarcs;i++) {
            this.rose[i] = []
        }
        this.#loadBands();
    }

    /**
     * Preload a bulk collection of records into the system. While it's possible to simply call "update" multiple
     * times, there are more concise ways of representing tens of thousands of values. This method defines two:
     *
     *  {"format":"simple","when":N,"records":[a,b,c, a,b,c ... ]}
     *
     * For the simple format, specify a start date in ms since the epoch, then an array of Nx3 values, where the
     * "a" value is the direction, the "b" value the speed, and the "c" value the milliseconds since the previous
     * record (or the "when" value for the first record)
     *
     *  {"format":"delta","when":N,"skip":M,"numarcs":A,"bands":[b1,b2,b3...],"records":[v, v, {"when:d}, v, v ...]
     *
     * This more complex record is more consise still. The "when" value is the same as above and "skip" defines
     * the default number of ms between successive records. "numarcs" is the number of segments on the rose; if each
     * segment was 20° this value would be 18. "bands" are the speed bands, so [var(--speed1), var(---speed2) etc],
     * and "records" is an encoded sequence of numbers and/or time adjustments: a values of the form {"when":d} specifies
     * a delta to be applied to the timestamp derived from the initial "when" and a series of "step" increments.
     *
     * The "v" values are integers. Create a variable bucket=0, meaning "arc 0, band 0" (0°, the lowest speed). Each
     * "v" value is added to the previous bucket value to assign the record to an arc/band segment: 1=[arc 1, band 0] etc,
     * with the band increasing when arc >= numarcs. A bucket value of -1 means speed=0.
     */
    preload(data) {
        this.#preloading = true;
        try {
            let start; 
            let a = [];
            if (data.format == "delta") {
                let numarcs = this.rose.length;
                let step = data.step;
                let when = data.when;
                start = when;
                let records = data.records;
                let target = 0;
                let lastwhen = when;
                for (let i=0;i<records.length;i++) {
                    let v = records[i];
                    if (typeof v == "number") {
                        target += v;
                        let dir = 0, speed = 0;
                        if (target >= 0) {
                            let band = Math.floor(target / numarcs);
                            let arc = target - (band * numarcs);
                            dir = (arc + 0.5) * this.options.arc;
                            speed = (this.bands[band] + (band == 0 ? 0 : this.bands[band - 1])) / 2;
                        }
                        a.push(dir);
                        a.push(speed);
                        a.push(when - lastwhen);
                        lastwhen = when;
                        when += step;
                    } else if (v.when) {
                        when += v.when;
                    }
                }
            } else {
                start = data.when;
                a = data.records;
            }
            // Load in smaller batches to not lock the UI
            let recordcount = 0, bandcount = [];
            let f = (when, off) => {
//                console.log("batch: when="+new Date(when).toISOString()+" off="+off+"/"+a.length);
                let end = Math.min(a.length, off + (500 * 3));
                while (off < end) {
                    let dir = a[off++];
                    let speed = a[off++];
                    when += a[off++];
                    this.#update(dir, speed, when);
                    let band = 0;
                    if (speed > 0) {
                        for (let j=0;j<this.bands.length;j++) {
                            if (speed < this.bands[j]) {
                                band = j + 1;
                                break;
                            }
                        }
                    }
                    while (band >= bandcount.length) {
                        bandcount.push(0);
                    }
                    bandcount[band]++;
                    recordcount++;
                }
                if (end == a.length) {
                    this.#preloading = false;
                    console.log("Wind-rose \"" + this.options.id + "\": pre-loaded " + recordcount + " \"" + data.format + "\" records from " + new Date(start).toISOString()+" to " + new Date(when).toISOString()+": speed histogram=" + JSON.stringify(bandcount));
                } else {
                    setTimeout(() => { f(when, end) }, 0);
                }
            }
            setTimeout(() => { f(start, 0) }, 0);
        } catch (e) {
            this.#preloading = false;
            throw e;
        }
    }

    /**
     * Add an anemometer event. Parameters can also be specified as an object, eg update({dir:340,speed:2});
     * @param dir the direction in degrees
     * @param speed the speed in units
     * @param when the timestamp in seconds or milliseconds (if missing, set to now)
     */
    update(dir, speed, when) {
        if (this.#preloading) {
            return;
        }
        if (typeof speed == "undefined" && typeof when == "undefined" && typeof dir == "object") {
            speed = dir.speed;
            when = dir.when;
            dir = dir.dir;
        }
        if (!when) {
            when = Date.now();
        } else if (when < 1000000000000) {     // convert from s to ms
            when *= 1000;
        }
        this.#loadBands();
        if (this.options.debug) {
            console.log("Wind-rose \"" + this.options.id + "\": update: dir="+dir+" speed="+speed+" when="+new Date(when).toISOString());
        }
        this.#update(dir, speed, when);
        requestAnimationFrame(() => { this.#animate() });
    }

    #update(dir, speed, when) {
        const now = Date.now();
        const numarcs = this.rose.length;
        speed = Math.max(0, speed);
        dir = speed == 0 ? 0 : ((dir % 360) + 360) % 360;

        const msg = {
            dir: dir,
            speed: speed,
            when: when,
            x: Math.sin(dir * Math.PI / 180) * speed,
            y: -Math.cos(dir * Math.PI / 180) * speed
        };
        if (this.q.length == 0 || this.q[this.q.length - 1].when < when) {
            this.q.push(msg);
        } else {
            for (let i=this.q.length-1;i>=0;i--) {
                let r = this.q[i];
                if (r.when == when && r.speed == speed && r.dir == dir) {
                    return;     // discard duplicates
                }
                if (i == 0 || this.q[i - 1].when < msg.when) {
                    this.q.splice(i, 0, msg);
                    break;
                }
            }
        }

        // First delete any expired messages
        while ((this.options.max_data_count && this.q.length > this.options.max_data_count) || (this.options.max_data_age && now - this.q[0].when > this.options.max_data_age)) {
            let delmsg = this.q.shift();
            let o;
            if (delmsg.speed == 0) {
                o = this.rose0;
            } else {
                delmsg.arc = Math.round(delmsg.dir / this.options.arc);
                if (delmsg.arc < 0) {
                    delmsg.arc += numarcs;
                } else if (delmsg.arc >= numarcs) {
                    delmsg.arc -= numarcs;
                }
                for (delmsg.band=0;delmsg.band<this.bands.length;delmsg.band++) {
                    if (this.bands[delmsg.band] > delmsg.speed) {
                        break;
                    }
                }
                o = this.rose[delmsg.arc][delmsg.band];
            }
            //console.log("del dir="+delmsg.dir+" speed="+delmsg.speed+" arc="+delmsg.arc+"/"+numarcs+" band="+delmsg.band+"/"+this.bands.length);
            o.count--;
            if (o.count) {
                o.oldest = msg.next;
            } else {
                delete o.oldest;
                delete o.newest;
            }
        }

        let o;
        if (speed == 0) {
            o = this.rose0;
        } else {
            let band = 0;
            for (band=0;band < this.bands.length;band++) {
                this.options.key.children[band].style.display = null;
                if (speed < this.bands[band]) {
                    break;
                }
            }
            let arc = Math.round(dir / this.options.arc);
            if (arc < 0) {
                arc += numarcs;
            } else if (arc >= numarcs) {
                arc -= numarcs;
            }
            // console.log("add dir="+dir+" speed="+speed+" arc="+arc+"/"+numarcs+" band="+band+"/"+this.bands.length);
            while (band >= this.rose[arc].length) {
                this.rose[arc].push({count:0});
            }
            o = this.rose[arc][band];
        }
        o.count++;
        if (o.newest) {
            o.newest.next = msg;
        }
        o.newest = msg;
        if (o.count == 0) {
            o.oldest = msg;
        }

        const total = this.q.length;
        let maxfreq = this.rose0.count / total;
        let minfreq = maxfreq;
        let minmindir = 0, maxmindir = 0;
        for (let i=0;i<numarcs;i++) {
            let c = 0;
            for (let j=0;j<this.rose[i].length;j++) {
                c += this.rose[i][j].count;
            }
            let freq = c / total;
            if (freq > maxfreq) {
                maxfreq = freq;
            }
            if (freq < minfreq) {
                minfreq = freq;
                minmindir = maxmindir = i;
            } else if (freq == minfreq && i == maxmindir + 1) {
                maxmindir = i;
            }
        }
        if (maxfreq > 1) {
            console.log("rose0="+this.rose0.count+"/"+total);
            for (let i=0;i<numarcs;i++) {
                let x = [];
                for (let j=0;j<this.rose[i].length;j++) {
                    x.push(this.rose[i][j].count);
                }
                console.log("rose["+i+"]="+JSON.stringify(x));
            }
            throw new Error("maxfreq="+maxfreq);
        }
        maxfreq = Math.max(Math.min(maxfreq, this.options.freq_max), this.options.freq_min);
        const freqsteps = Math.ceil(maxfreq / (this.options.freq_step / 100));
        if (freqsteps != this.#freqsteps) {
            const g = this.svg.querySelector(".scale");
            while (g.firstChild) {
                g.firstChild.remove();
            }
            for (let i=1;i<=freqsteps;i++) {
                let elt = document.createElementNS(this.#SVGNS, "circle");
                let r = Math.round(this.options.radius * i / freqsteps);
                elt.setAttribute("r", r);
                g.appendChild(elt);
                let text = document.createElementNS(this.#SVGNS, "text");
                let angle = ((minmindir + maxmindir) / 2 * this.options.arc) * Math.PI / 180;
                text.setAttribute("x", Math.round(Math.sin(angle) * r));
                text.setAttribute("y", Math.round(-Math.cos(angle) * r));
                text.innerHTML = Math.round(this.options.freq_step * i) + "%";
                g.appendChild(text);
            }
            this.#freqsteps = freqsteps;
        }
        maxfreq = freqsteps * this.options.freq_step / 100;
        const scale = this.options.radius / maxfreq;

        const g = this.svg.querySelector(".wind");
        const mul = this.options.arc * Math.PI / 180;
        for (let i=0;i<numarcs;i++) {
            let freq0 = 0;
            for (let j=0;j<this.rose[i].length;j++) {
                o = this.rose[i][j];
                if (o.count == 0) {
                    if (o.elt) {
                        o.elt.remove();
                        delete o.elt;
                    }
                } else {
                    if (!o.elt) {
                        o.elt = document.createElementNS(this.#SVGNS, "path");
                        o.elt.style.fill = "var(--speed" + (this.bands[j] == this.#MAXSPEED ? "max" : this.bands[j]) + ")";
                        o.elt.classList.add("band" + j);
                        g.appendChild(o.elt);
                    }
                    let freq = o.count / total;
                    let freq1 = freq0 + freq;
                    let r0 = freq0 * scale;
                    let r1 = freq1 * scale;
                    let p0x = Math.sin((i - 0.5) * mul) * r0;
                    let p0y = -Math.cos((i - 0.5) * mul) * r0;
                    let p1x = Math.sin((i - 0.5) * mul) * r1;
                    let p1y = -Math.cos((i - 0.5) * mul) * r1;
                    let p2x = Math.sin((i + 0.5) * mul) * r1;
                    let p2y = -Math.cos((i + 0.5) * mul) * r1;
                    let p3x = Math.sin((i + 0.5) * mul) * r0;
                    let p3y = -Math.cos((i + 0.5) * mul) * r0;
                    o.elt.setAttribute("d", "M " + p0x + " " + p0y + " L " + p1x + " " + p1y + " A " + r1 + " " + r1 + " 0 0 1 " + p2x + " " + p2y + " L " + p3x + " " +p3y + " A " + r0 + " " + r0 + " 0 0 0 " + p0x + " " + p0y);
                    freq0 = freq1;
                }
            }
        }
        o = this.rose0;
        if (o.count == 0) {
            if (o.elt) {
                o.elt.remove();
                delete o.elt;
            }
        } else {
            if (!o.elt) {
                o.elt = document.createElementNS(this.#SVGNS, "circle");
                o.elt.style.fill = "var(--speed0)";
                g.insertBefore(o.elt, g.firstChild);
            }
            let freq = o.count / total;
            o.elt.setAttribute("r", Math.round(freq * scale));
        }
    }

    /**
     * Update the key and the bands array
     * @param speed the new max speed
     */
    #loadBands() {
        if (!this.bands && document.contains(this.svg)) {
            this.bands = [];
            const style = window.getComputedStyle(this.svg);
            this.svg.style.setProperty("--radius", this.options.radius + "px");
            if (!style.getPropertyValue("--speedmax")) {
                this.svg.style.setProperty("--speedmax", "red");
            }
            for (let i=1;i<this.#MAXSPEED;i++) {
                if (style.getPropertyValue("--speed" + i)) {
                    this.bands.push(i);
                }
            }
            this.bands.push(this.#MAXSPEED);

            let key = this.options.key;
            if (!key) {
                let fo = document.createElementNS(this.#SVGNS, "foreignObject");
                fo.setAttribute("x", this.svg.viewBox.baseVal.x);
                fo.setAttribute("x", this.svg.viewBox.baseVal.y);
                fo.setAttribute("width", this.svg.viewBox.baseVal.width);
                fo.setAttribute("height", this.svg.viewBox.baseVal.height);
                this.svg.appendChild(fo);
                key = document.createElement("div");
                key.classList.add("key");
                fo.appendChild(key);
                this.options.key = key;
            }
            while (key.firstChild) {
                key.firstChild.remove();
            }
            for (let i=0;i<this.bands.length;i++) {
                let min = i == 0 ? 0 : this.bands[i - 1];
                let max = this.bands[i];
                let e = document.createElement("div");
                key.appendChild(e);
                e.style.background = style.getPropertyValue("--speed" + (max == this.#MAXSPEED ? "max" : max));
                e.style.display = "none";
                let s = document.createElement("span");
                e.appendChild(s);
                if (max == this.#MAXSPEED) {
                    s.innerHTML = "> " + min + this.options.units;
                } else {
                    s.innerHTML = min + "-" + max + this.options.units;
                }
            }
            for (let i=0;i<this.options.minbands;i++) {
                let x = this.options.key.children[i];
                if (x) {
                    x.style.display = null;
                }
            }
        }
    }

    /**
     * The animation callback. Must be fast.
     */
    #animate() {
        try {
            const now = Date.now() - this.options.lag;

            let i;
            for (i=this.q.length - 2;i>=0;i--) {
                if (this.q[i].when <= now) {
                    break;
                }
            }
            if (i >= 0) {
                const p0 = this.q[i];
                const p1 = this.q[i + 1];
                const p2 = i + 2 >= this.q.length ? p1 : this.q[i + 2];
                const p3 = i + 3 >= this.q.length ? p2 : this.q[i + 3];
                const t = (now - p0.when) / (p1.when - p0.when);
                const t1 = 1-t;
                const x = ((2*p1.x) + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t*t + (-p0.x+3*p1.x-3*p2.x+p3.x)*t*t*t) * 0.5;
                const y = ((2*p1.y) + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t*t + (-p0.y+3*p1.y-3*p2.y+p3.y)*t*t*t) * 0.5;
                let scale = this.options.radius / this.bands[this.bands.length - (this.bands[this.bands.length - 1] == this.#MAXSPEED ? 2 : 1)];
                const speed = Math.sqrt(x*x + y*y);
                if (speed <= this.bands[0]) {
                    this.#ball.style.fill = "var(--speed" + this.bands[0] + ")";
                } else if (this.bands[this.bands.length - 1] == this.#MAXSPEED && speed >= this.bands[this.bands.length - 2]) {
                    this.#ball.style.fill = "var(--speedmax)";
                } else {
                    let band;
                    for (band=1;band<this.bands.length;band++) {
                        if (this.bands[band] >= speed) {
                            let s0 = this.bands[band - 1];
                            let s1 = this.bands[band];
                            let p = Math.round((speed - s0) / (s1 - s0) * 100);
                            this.#ball.setAttribute("data-band", band);
                            this.#ball.style.fill = "color-mix(in srgb, var(--speed" + s0 + "), var(--speed" + s1 + ") " + p + "%)";
                            break;
                        }
                    }
                }
                this.#ball.style.transform = "translate(" + Math.round(x * scale) + "px, " + Math.round(y * scale) + "px)";
                while (this.#ballText.firstChild) {
                    this.#ballText.firstChild.remove();
                }
                this.#ballText.appendChild(document.createTextNode(speed.toFixed("1") + this.options.units));
                if (i > 0) {
                    delete this.q[i - 1].x;     // properties not needed. Save space?
                    delete this.q[i - 1].y;
                }
                requestAnimationFrame(() => { this.#animate() });
                return;
            }
        } catch (e) {
            console.log(e);
        }
    }

}
