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
    #mqtt;
    #freqsteps;
    rose;               // the rose 2D array
    bands;              // the bands array containing the upper-bound of each speed band
    svg;                // the target SVG
    options;            // the options
    q = [];             // the queue of events

    constructor(svg, options) {
        this.svg = svg;
        this.svg.classList.add("wind-rose");
        if (!this.svg.viewBox.baseVal) {
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
            this.options.radius = (Math.min(this.svg.viewBox.baseVal.width, this.svg.viewBox.baseVal.height) / 2) - 1;
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

        this.rose = [];
        for (let i=0;i<numarcs;i++) {
            this.rose[i] = []
        }
        this.bands = [];
    }

    /**
     * Connect to the specified MQTT URL and subscribe to the specified topic.
     * Messages are expected to contain keys "speed" (in units) and "dir" (in degrees), and an optional "when" (timestamp in s or ms)
     * @param url the URL, relative to the document location, eg "/ws"
     * @param topic the topic, eg "anemometer"
     */
    subscribe(url, topic) {
        if (!url) {
            throw new Error("No URL");
        }
        if (!topic) {
            throw new Error("No topic");
        }
        if (!(url instanceof URL)) {
            url = new URL(url, window.location);
        }
        let ssl = url.protocol == "https:";
        let port = url.port ? url.port : ssl ? 443 : 80;
        this.#mqtt = new Paho.MQTT.Client(url.hostname, port, url.pathname, "WindRose@" + window.location);
        const that = this;
        const mqtt = this.#mqtt;
        mqtt.onMessageArrived = (msg) => {
            try {
                msg = JSON.parse(msg.payloadString);
                that.update(msg.dir, msg.speed, msg.when);
            } catch (e) {
                console.log(e);
            }
        };
        mqtt.connect({
            onSuccess: () => {
                console.log("Connected to " + url + ", subscribing to \"" + topic + "\"");
                mqtt.subscribe(topic);
            },
            useSSL: ssl
        });
    }

    /**
     * Add an anemometer event. Parameters can also be specified as an object, eg update({dir:340,speed:2});
     * @param dir the direction in degrees
     * @param speed the speed in units
     * @param when the timestamp in seconds or milliseconds (if missing, set to now)
     */
    update(dir, speed, when) {
        if (!speed && !when && typeof dir == "object") {
            speed = dir.speed;
            when = dir.when;
            dir = dir.dir;
        }
        const now = Date.now();
        const numarcs = this.rose.length;
        dir = ((dir % 360) + 360) % 360;
        speed = Math.abs(speed);

        if (!when) {
            when = now;
        } else if (when < 1756318354000) {     // convert from s to ms
            when *= 1000;
        }
        const msg = {
            dir: dir,
            speed: speed,
            when: when,
            x: Math.sin(dir * Math.PI / 180) * speed,
            y: -Math.cos(dir * Math.PI / 180) * speed
        };
        this.q.push(msg);
        requestAnimationFrame(() => { this.#animate() });

        if (speed > 0) {
            // First delete any expired messages
            while ((this.options.max_data_count && this.q.length > this.options.max_data_count) || (this.options.max_data_age && now - this.q[0].when > this.options.max_data_age)) {
                let delmsg = this.q.shift();
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
                let o = this.rose[delmsg.arc][delmsg.band];
                //console.log("del dir="+delmsg.dir+" speed="+delmsg.speed+" arc="+delmsg.arc+"/"+numarcs+" band="+delmsg.band+"/"+this.bands.length);
                o.count--;
                if (o.count) {
                    o.oldest = msg.next;
                } else {
                    delete o.oldest;
                    delete o.newest;
                }
            }

            let band = 0;
            while (true) {
                if (band == this.bands.length) {
                    this.#updateBands(speed);
                    if (band == this.bands.length) {
                        break;
                    }
                }
                if (speed < this.bands[band]) {
                    break;
                }
                band++;
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
            let o = this.rose[arc][band];
            o.count++;
            if (o.newest) {
                o.newest.next = msg;
            }
            o.newest = msg;
            if (o.count == 0) {
                o.oldest = msg;
            }


            const total = this.q.length;
            let maxfreq = 0;
            let minfreq = 0;
            let minmindir = 0, maxmindir = 0;
            for (let i=0;i<numarcs;i++) {
                let c = 0;
                for (let j=0;j<this.rose[i].length;j++) {
                    c += this.rose[i][j].count;
                }
                let freq = c / total;
                if (i == 0) {
                    minfreq = maxfreq = freq;
                } else {
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
        }
    }

    /**
     * Update the key and the bands array
     * @param speed the new max speed
     */
    #updateBands(speed) {
        speed = Math.ceil(speed);
        this.bands = [];

        const style = window.getComputedStyle(this.svg);
        if (!style.getPropertyValue("--speedmax")) {
            this.svg.style.setProperty("--speedmax", "red");
        }
        for (let i=1;i<this.#MAXSPEED;i++) {
            if (style.getPropertyValue("--speed" + i)) {
                this.bands.push(i);
                if (i > speed && this.bands.length >= this.options.minbands) {
                    break;
                }
            }
        }
        if (speed > this.bands[this.bands.length - 1] || this.options.minbands > this.bands.length + 1) {
            this.bands.push(this.#MAXSPEED);
        }

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
            e.style.background = "var(--speed" + (max == this.#MAXSPEED ? "max" : max) + ")";
            let s = document.createElement("span");
            e.appendChild(s);
            if (max == this.#MAXSPEED) {
                s.innerHTML = "> " + min + this.options.units;
            } else {
                s.innerHTML = min + "-" + max + this.options.units;
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
