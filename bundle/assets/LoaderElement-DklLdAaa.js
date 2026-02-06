let n;function o(){n||(n=document.createElement("style"),n.textContent=`

		.loader-container, .description {
			position: absolute;
			width: 100%;
			font-family: 'Courier New', Courier, monospace;
			color: white;
			font-weight: light;
			align-items: flex-start;
			font-size: 14px;
			pointer-events: none;
			user-select: none;
			z-index: 100;
		}

		.loader-container {
			display: flex;
			flex-direction: column;
			bottom: 0;
			left: 0;
		}

		.description {
			top: 0;
			width: 100%;
			text-align: center;
			padding: 5px 0;
		}

		.loader-container .bar {
			height: 2px;
			background: white;
			width: 100%;
		}

		.loader-container .credits,
		.loader-container .samples,
		.loader-container .percentage {
			padding: 5px;
			margin: 0 0 1px 1px;
			background: rgba( 0, 0, 0, 0.2 );
			border-radius: 2px;
			display: inline-block;
		}

		.loader-container:not(.loading) .bar,
		.loader-container:not(.loading) .percentage,
		.loader-container.loading .credits,
		.loader-container.loading .samples,
		.loader-container .credits:empty {
			display: none;
		}

		.loader-container .credits a,
		.loader-container .credits,
		.loader-container .samples {
			color: rgba( 255, 255, 255, 0.75 );
		}

		.loader-container .samples {
			font-size: 12px;
			letter-spacing: 0.5px;
		}
	`,document.head.appendChild(n))}class l{constructor(){o();const e=document.createElement("div");e.classList.add("loader-container");const i=document.createElement("div");i.classList.add("percentage"),e.appendChild(i);const t=document.createElement("div");t.classList.add("samples"),e.appendChild(t);const a=document.createElement("div");a.classList.add("credits"),e.appendChild(a);const s=document.createElement("div");s.classList.add("bar"),e.appendChild(s);const r=document.createElement("div");r.classList.add("description"),e.appendChild(r),this._description=r,this._loaderBar=s,this._percentage=i,this._credits=a,this._samples=t,this._container=e,this.setPercentage(0)}attach(e){e.appendChild(this._container),e.appendChild(this._description)}setPercentage(e){this._loaderBar.style.width=`${e*100}%`,e===0?this._percentage.innerText="Loading...":this._percentage.innerText=`${(e*100).toFixed(0)}%`,e>=1?this._container.classList.remove("loading"):this._container.classList.add("loading")}setSamples(e,i=!1,t=0){i?this._samples.innerText="compiling shader...":t>0?this._samples.innerText=`${Math.floor(e)} / ${t} samples`:this._samples.innerText=`${Math.floor(e)} samples`}setCredits(e){this._credits.innerHTML=e}setDescription(e){this._description.innerHTML=e}}export{l as L};
//# sourceMappingURL=LoaderElement-DklLdAaa.js.map
