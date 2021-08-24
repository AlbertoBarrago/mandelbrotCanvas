class Tile {
    constructor(x, y, width, height) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
    }

    static *tiles(width, height, numRows, numCols) {
        let columnWidth = Math.ceil(width / numCols);
        let rowHeight = Math.ceil(width / numRows);

        for(let row = 0; row < numRows; row++) {
            let tileHeight = (row < numRows - 1)
                ? rowHeight
                : height - rowHeight * (numRows-1);
            for(let col = 0; col < numCols; col++) {
                let tileWidth = (col < numCols -1)
                    ? columnWidth
                    : width - columnWidth * (numCols -1);

                yield new Tile(col * columnWidth, row * rowHeight, tileWidth, tileHeight);
            }
        }
    }
}

class WorkerPool {
    constructor(numWorkers, workerSource) {
        this.idleWorkers = [];
        this.workQueue = [];
        this.workerMap = new Map();

        for(let i = 0; i < numWorkers; i++) {
            let worker = new Worker(workerSource);
            worker.onmessage = message => {
                this._workerDone(worker, null, message.data);
            };
            worker.onerror = error => {
                this._workerDone(worker, error, null);
            }
            this.idleWorkers[i] = worker;
        }
    }

    _workerDone(worker, error, response) {
        let [resolver, rejector] = this.workerMap.get(worker);
        this.workerMap.delete(worker);

        if(this.workQueue.length === 0) {
            this.idleWorkers.push(worker);
        } else {
            let [work, resolver, rejector] = this.workQueue.shift();
            this.workerMap.set(worker, [resolver, rejector]);
            worker.postMessage(work);
        }

        error === null ? resolver(response) : rejector(error);
    }

    addWork(work) {
        return new Promise((resolve,reject) => {
            if(this.idleWorkers.length > 0 ) {
                let worker = this.idleWorkers.pop();
                this.workerMap.set(worker, [resolve, reject]);
                worker.postMessage(work);
            } else {
                this.workQueue.push([work, resolve, reject]);
            }
        })
    }
}


class PageState {
 static initialState() {
     let s = new PageState();
     s.cx = 0.5;
     s.cy = 0;
     s.perPixel = 3/window.innerHeight;
     s.maxIterations = 500;
     return s;
 }

 static fromUrl(url) {
     let s = new PageState();
     let u = new URL(url);
     s.cx = parseFloat(u.searchParams.get("cx"));
     s.cy = parseFloat(u.searchParams.get("cy"));
     s.perPixel = parseFloat(u.searchParams.get("pp"));
     s.maxIterations = parseFloat(u.searchParams.get("it"));

     return (isNaN(s.cx) || isNaN(s.cy) || isNaN(s.perPixel) || isNaN(s.maxIterations))
            ? null
            : s;
 }

 toUrl() {
     let u = new URL(window.location);
     u.searchParams.set("cx", this.cx);
     u.searchParams.set("cy", this.cy);
     u.searchParams.set("pp", this.perPixel);
     u.searchParams.set("it", this.maxIterations);
     return u.href;
 }

}

const ROWS = 3, COLS = 4, NUMWORKERS = navigator.hardwareConcurrency || 2;

class MandelbrotCanvas {
    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext("2d");
        this.workerPool = new WorkerPool(NUMWORKERS, "mandelbrotWorker.js")

        this.tiles = null;
        this.pendingRender = null;
        this.wantsRender = false;
        this.resixeTimer = null;
        this.colorTable = null;

        this.canvas.addEventListener("pointerdown", e => this.handlePointer(e));
        window.addEventListener("keydown", e => this.handleKey(e));
        window.addEventListener("resize", e => this.handleResize(e));
        window.addEventListener("popstate", e => this.setState(e.state, false));

        this.state = PageState.fromUrl(window.location) || PageState.initialState();

        history.replaceState(this.state, "", this.state.toUrl());

        this.setSize();

        this.render();
    }


    setSize() {
        this.width = this.canvas.width = window.innerWidth;
        this.height = this.canvas.height = window.innerHeight;
        this.tiles = [...Tile.tiles(this.width, this.height, ROWS, COLS)];
    }

    setState(f, save=true) {
        if(typeof f === "function") {
            f(this.state);
        } else {
            for (let property in f ){
                this.state[property = f[property]];
            }
        }

        this.render();

        if(save) {
            history.pushState(this.state, "", this.state.toUrl());
        }
    }

    render() {
        if(this.pendingRender) {
            this.wantsRender = true;
            return;
        }

        let {cx, cy, perPixel,  maxIterations} = this.state;
        let x0 = cx - perPixel * this.width/2;
        let y0 = cy - perPixel * this.height/2;

        let promises = this.tiles.map(tile => this.workerPool.addWork({
            tile: tile,
            x0: x0 + tile.x * perPixel,
            y0: y0 + tile.y * perPixel,
            perPixel: perPixel,
            maxIterations: maxIterations
        }));

        this.pendingRender = Promise.all(promises).then(response => {
            let min = maxIterations, max = 0;
            for(let r of response) {
                if(r.min < min) min = r.min;
                if(r.max > max) max = r.max;
            }

            if(!this.colorTable || this.colorTable.length !== maxIterations+1) {
                this.colorTable = new Uint32Array(maxIterations+1);
            }

            if(min === max) {
                if(min === maxIterations) {
                    this.colorTable[min] = 0xFF000000;
                } else {
                    this.colorTable[min] = 0;
                }
            } else {
                let maxLog = Math.log(1+max-min);
                for(let i = min; i <= max; i++) {
                    this.colorTable[i] = (Math.ceil(Math.log(1+i-min)/maxLog * 255) << 24);
                }
            }

            for(let r of response) {
                let iterations = new Uint32Array(r.imageData.data.buffer);
                for(let i = 0; i < iterations.length; i++) {
                    iterations[i] = this.colorTable[iterations[i]];
                }
                this.canvas.style.transform = "";
                for(let r of response) {
                    this.context.putImageData(r.imageData, r.tile.x, r.tile.y);
                }
            }

        })
        .catch((reason) => {
            console.error("Promise rejected in render():", reason);
        })
        .finally(()=> {
            this.pendingRender = null;
            if(this.wantsRender) {
                this.wantsRender = false;
                this.render();
            }
        })
    }

    handleResize(event) {
        if(this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null;
            this.setSize();
            this.render();
        }, 200)
    }

    handleKey(event) {
        switch(event.key) {
            case "Escape":
                this.setState(PageState.initialState());
                break;
            case "+":
                this.setState(s => {
                    s.maxIterations = Math.round(s.maxIterations*1.5);
                })
                break;
            case "-":
                this.setState(s => {
                    s.maxIterations = Math.round(s.maxIterations/1.5);
                    if(s.maxIterations < 1) s.maxIterations = 1;
                })
                break;
            case "o":
                this.setState(s => s.perPixel *= 2);
                break;
            case "ArrowUp":
                this.setState(s => s.cy -= this.height/10 * s.perPixel);
                break;
            case "ArrowDown":
                this.setState(s => s.cy += this.height/10 * s.perPixel);
                break;
            case "ArrowLeft":
                this.setState(s => s.cx -= this.width/10 * s.perPixel);
                break;
            case "ArrowRight":
                 this.setState(s => s.cx *= this.width/10 * s.perPixel);
                break;

        }
    }

    handlePointer(event) {
        const x0 = event.clientX, y0 = event.clientY, t0 = Date.now();

        const pointerMoveHandler = event => {
            let dx = event.clientX, dy=event.clientY, dt=Date.now-t0;

            if(dx > 10 || dy > 10 || dt > 500) {
                this.cavans.style.trasnform = `translate(${dx}px, ${dy}px)`;
            }
        }

        const pointerUpHandler = event => {
            this.canvas.removeEventListener("pointerMove", pointerMoveHandler);
            this.cavans.removeEventListener("pointerUp", pointerUpHandler);

            const dx = event.clientX-x0, dy=event.clientY-y0, dt=Date.now()-t0;
            const {cx, cy, perPixel} = this.state;

            if(dx > 10 || dy > 10 || dt > 500) {
                this.setState({cx: cx - dx*perPixel, cy: cy - dy*perPixel});
            } else {
                let cdx = x0 - this.width/2;
                let cdy = y0 - this.height/2;

                this.canvas.style.trasnform = `translate(${-cdx}px, ${-cdy}px scale(2))`;

                this.setState(s => {
                    s.cx += cdx * s.perPixel;
                    s.cy += cdy * s.perPixel;
                    s.perPixel /= 2
                });
            }

        };


        this.canvas.addEventListener("pointerMove", pointerMoveHandler);
        this.canvas.addEventListener("pointerUp", pointerUpHandler);
    }

}



