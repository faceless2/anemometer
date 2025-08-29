#!/usr/bin/env node

// Read NMEA $WIMWV sentences from an input device and optionally publish them to MQTT
// Also store them and reply them in a (relatively) efficient way when asked.
//
// Publish anemometer readings in m/s, direction in degrees and temperature in degrees
//
"use strict";

const fs = require("fs");
const os = require("os");

let inputfile, historyfile, historysize, lasthistorysave = Date.now();
let mqtt_client, mqtt_host, mqtt_topic, mqtt_announce_topic;
let minfrequency = 0, maxfrequency = 0, flag_publishalways, offset = 0;
let history;

for (let i=2;i<process.argv.length;i++) {
    if (process.argv[i] == "--input") {
        inputfile = process.argv[++i];
    } else if (process.argv[i] == "--offset") {
        offset = process.argv[++i] * 1;
        if (!(offset >= -180 && offset <= 180)) {
            ofset = 0;
        }
    } else if (process.argv[i] == "--history-size") {
        historysize = process.argv[++i] * 1;
    } else if (process.argv[i] == "--history-file") {
        historyfile = process.argv[++i];
    } else if (process.argv[i] == "--mqtt") {
        mqtt_host = process.argv[++i];
    } else if (process.argv[i] == "--topic") {
        mqtt_topic = process.argv[++i];
    } else if (process.argv[i] == "--topic-announce") {
        mqtt_announce_topic = process.argv[++i];
    } else if (process.argv[i] == "--all") {
        flag_publishalways = true;
    } else if (process.argv[i] == "--min-frequency") {
        minfrequency = process.argv[++i] * 1;
        if (!(minfrequency > 0)) {
            minfrequency = 0;
        }
    } else if (process.argv[i] == "--max-frequency") {
        maxfrequency = process.argv[++i] * 1;
        if (!(maxfrequency > 0)) {
            maxfrequency = 5 * 60 * 1000;       // 5mins
        }
    } else {
        console.log("Unknown argument \"" + process.argv[i] + "\"");
        console.log("Usage: anemometer.js args...");
        console.log();
        console.log("  --offset <angle>            add the specified offset in degrees to all wind angles (default: 0)");
        console.log("  --input <file>              specify input to readfrom: filename, /dev/ttyUSB0, defaults to stdin");
        console.log("  --history-size <number>     number of records to record in history (default: 0, or 86400 if file specified");
        console.log("  --history-file <file>       file to write history records to, on exit or once an hour");
        console.log("  --mqtt <url>                MQTT url to connect to, eg mqtt://mqtt.local (default: none)");
        console.log("  --topic <string>            MQTT topic for sent messages; also listens on \"{topic}/history\"");
        console.log("  --topic-announce <string>   optional MQTT topic to announce connection/disconnection as");
        console.log("  --min-frequency <number>    never send messages more rapidly than this value in ms (default: 0");
        console.log("  --max-frequency <number>    always send at least one message in this period in ms (default: 5mins)");
        console.log("  --all                       send all messages; default is only where speed/dir has changed");
        console.log();
        process.exit();
    }
}

if (historyfile) {
    if (!historysize) {
        historysize = 86400;
    }
    function exitHandler() {
        savehistory();
        process.exit();
    }
    process.on("exit", exitHandler.bind());
    process.on("SIGINT", exitHandler.bind());
    process.on("SIGTERM", exitHandler.bind());
    process.on('uncaughtException', (err, origin) => {
        console.log(err);
        exitHandler();
    });
}

if (historysize > 0) {
    history = [];
}
if (fs.existsSync(historyfile)) {
    let x = fs.readFileSync(historyfile) + "\n";
    let j=0, i;
    while ((i=x.indexOf("\n", j)) >= 0) {
        let l = x.substring(j, i);
        try {
            let x = JSON.parse(l);
            if (typeof x.dir == "number" && typeof x.speed == "number" && typeof x.when == "number") {
                history.push({"dir":x.dir, "speed":x.speed, "when":x.when});
            }
        } catch (e) { }
        j = i + 1;
    }
    history.sort((a,b) => {
        return a.when - b.when;
    });
    console.log("# Loaded " + history.length + " items from history file");
}

if (mqtt_host && mqtt_topic) {
    const mqtt = require("mqtt")
    let o = {};
    if (mqtt_announce_topic) {
        o.will = { topic: mqtt_announce_topic, payload: JSON.stringify({connect: false, who: __filename, where: os.hostname()}),qos:0};
    }
    mqtt_client  = mqtt.connect(mqtt_host, o); 
    mqtt_client.on("connect", function(c) {
        console.log("# MQTT " + (c.sessionPresent?"re":"") + "connected to \"" + mqtt_host + "\"");
        if (mqtt_announce_topic) {
            mqtt_client.publish(mqtt_announce_topic, JSON.stringify({connect: true, repeat: c.sessionPresent, when: Date.now(), who: __filename, where: os.hostname()}));
        }
        mqtt_client.subscribe(mqtt_topic + "/history");
    });
    mqtt_client.on("message", (topic, msg) => {
        try {
            msg = JSON.parse(msg);
            msg = {
                who: __filename,
                where: os.hostname(),
                when: Date.now(),
                history: publishHistory(msg)
            };
            if (mqtt_client) {
                mqtt_client.publish(mqtt_topic, JSON.stringify(msg));
            } else {
                console.log(JSON.stringify(msg));
            }
        } catch (e) { 
            console.log(e);
        }
    });
}

if (/^\/dev\//.test(inputfile) && inputfile != "/dev/null") {
    const SerialPort = require("serialport");
    const Readline = SerialPort.parsers.Readline;
    const port = new SerialPort("/dev/ttyUSB0", { baudRate: 4800 });
    const parser = port.pipe(new Readline({ delimiter: "\r\n" }));
    parser.on("data", processLine);
    process.stdin.destroy();
} else {
    const readline = require("readline");
    let input = inputfile ? fs.createReadStream(inputfile) : process.stdin;
    readline.createInterface({ input: input, output: null }).on("line", processLine);
}

let msg = {};
let temperature, speed, dir;
let lastpublish = 0;
let minpublishdelay = 1000;

function savehistory() {
    try {
        let z = "";
        for (let i=0;i<history.length;i++) {
            z += JSON.stringify(history[i]) + "\n";
        }
        let f = historyfile + ".tmp";
        fs.writeFileSync(f, z);
        fs.renameSync(f, historyfile);
        console.log("# Saved " + history.length + " items to history file");
    } catch (e) {
        console.log(e);
    }
}

function processLine(data) {
//    console.log(data);
    const now = Date.now();
    try {
        let ix;
        if (data[0] == '$' && (ix=data.indexOf("*")) > 0) {
            let cs = 0; 
            for (let i=1;i<ix;i++) { 
                cs = cs ^ data.charCodeAt(i); 
            }
            cs = cs.toString(16).toUpperCase();
            if (cs.length == 1) {
                cs = "0" + cs;
            }
            if (data.endsWith(cs)) {
                data = data.split(",");
                let publish = false;
                if (data[0] == "$YXXDR") {
                    temperature = data[2] * 1;
                } else if (data[0] == "$WIMWV") {
                    dir = (data[1] * 1 + 720 + offset) % 360;
                    speed = data[3] * (data[4]=='M' ? 1 : data[4]=='K' ? 0.2777778 : data[4]=='N' ? 0.514444 : data[4]=='S' ? 0.44704 : 0);
                    speed = Math.round(speed * 10) / 10;
                    if (flag_publishalways || speed != msg.speed || (speed > 0 && dir != msg.dir) || now - lastpublish > maxfrequency) {
                        publish = true;
                    }
                }
                if (publish && now - lastpublish > minfrequency) {
                    if (history) {
                        history.push({"dir":dir,"speed":speed,"when":now});
                        if (history.length > historysize) {
                            history.shift();
                        }
                        if (now - lasthistorysave > 60*60*1000) {
                            savehistory();
                        }
                    }
                    msg = {
                        speed: speed,
                        dir: dir,
                        temperature: temperature,
                        who: __filename,
                        where: os.hostname(),
                        when: Date.now()
                    };
                    if (mqtt_client) {
                        mqtt_client.publish(mqtt_topic, JSON.stringify(msg));
                    } else {
                        console.log(JSON.stringify(msg));
                    }
                    lastpublish = Date.now();
                    delete msg.history;
                }
            } else {
//                console.log("Bad checksum: " + data + " should be " + cs);
            }
        }
    } catch (e) {
        console.log(e);
    }
}

function publishHistory(req) {
    if (!history) {
        return null;
    } else if (req.format == "delta" && req.numarcs > 0 && req.bands && req.bands.length > 0) {
        let records = [];
        let start;
        let guesswhen;
        let step = 1000;
        let msg = {format:"delta", step: step};
        const arcsize = 360 / req.numarcs;
        let last = 0;
        for (let i=0;i<history.length;i++) {
            let dir = history[i].dir;
            let speed = history[i].speed;
            let when = history[i].when;
            if (!start && (!req.when || when > req.when)) {
                start = guesswhen = when;
                msg.when = start;
            }
            let q0 = Math.round((when - start) / step);
            let q1 = Math.round((guesswhen - start) / step);
            if (q0 != q1) {
//                console.log("when="+when+" guesswhen="+guesswhen+" diff="+(when-guesswhen)+" q="+q0+" "+q1);
                records.push({when:when-guesswhen});
                start = guesswhen = when;
            }
            let target;
            if (speed == 0) {
                target = -1;
            } else {
                let arc = Math.round(dir / arcsize);
                if (arc < 0) {
                    arc += req.numarccs;
                } else if (arc > req.numarcs) {
                    arc -= req.numarccs;
                }
                let band;
                for (band = 0;band < req.bands.length && speed >= req.bands[band];band++);
                target = band * req.numarcs + arc;
//                console.log("dir="+dir+" speed="+speed+" arc="+arc+" band="+band+" target="+target+" last="+last);
            }
            records.push(target - last);
            last = target;
            guesswhen = guesswhen += step;
        }
        msg.records = records;
        if (req.id) {
            msg.id = req.id;
        }
        if (req.nonce) {
            msg.nonce = req.nonce;
        }
        return msg;
    } else {
        let records = [];
        let msg = {format:"simple"};
        let last;
        for (let i=0;i<history.length;i++) {
            let dir = history[i].dir;
            let speed = history[i].speed;
            let when = history[i].when;
            if (!last && (!req.when || when > req.when)) {
                last = when;
                msg.when = last;
            }
            records.push(dir);
            records.push(speed);
            records.push(when - last);
            last = when;
        }
        msg.records = records;
        if (req.id) {
            msg.id = req.id;
        }
        if (req.nonce) {
            msg.nonce = req.nonce;
        }
        return msg;
    }
}
