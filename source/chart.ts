export {}

const minFrequency = 20
const maxFrequency = 20_000
const defaultMicrophoneHint = 'Click to allow microphone access (required to visualize live audio).'
const octaveCount = Math.log2(maxFrequency / minFrequency)
const bandsPerOctave = 72
const bandCount = Math.ceil(octaveCount * bandsPerOctave)
let fftSize = 32_768
const pitchClasses = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const c4Frequency = 261.6255653005986
type Point = { x: number; y: number }
type BandPolygon = [Point, Point, Point, Point]

function getElement<T extends Element>(selector: string) {
	const element = document.querySelector<T>(selector)
	if (!element) {
		throw new Error(`The required page element is missing: ${selector}`)
	}
	return element
}

const canvas = getElement<HTMLCanvasElement>('#spiral')
const button = getElement<HTMLButtonElement>('#toggle-microphone')
const microphoneHint = getElement<HTMLSpanElement>('#mic-hint')
const tooltip = getElement<HTMLDivElement>('#tooltip')
const fftResolution = getElement<HTMLInputElement>('#fft-resolution')
const fftResolutionValue = getElement<HTMLOutputElement>('#fft-resolution-value')
const visualGain = getElement<HTMLInputElement>('#visual-gain')
const visualGainValue = getElement<HTMLOutputElement>('#visual-gain-value')
const openSettingsButton = getElement<HTMLButtonElement>('#open-settings')
const closeSettingsButton = getElement<HTMLButtonElement>('#close-settings')
const settingsPanel = getElement<HTMLElement>('#settings-panel')
const drawerBackdrop = getElement<HTMLButtonElement>('#drawer-backdrop')
const gradientStartPicker = getElement<HTMLInputElement>('#gradient-start')
const gradientEndPicker = getElement<HTMLInputElement>('#gradient-end')
const gradientStartOpacitySlider = getElement<HTMLInputElement>('#gradient-start-opacity')
const gradientStartOpacityValue = getElement<HTMLOutputElement>('#gradient-start-opacity-value')
const gradientEndOpacitySlider = getElement<HTMLInputElement>('#gradient-end-opacity')
const gradientEndOpacityValue = getElement<HTMLOutputElement>('#gradient-end-opacity-value')

function getCanvasContext(element: HTMLCanvasElement) {
	const canvasContext = element.getContext('2d')
	if (!canvasContext) {
		throw new Error('This browser does not support Canvas 2D.')
	}
	return canvasContext
}

const context = getCanvasContext(canvas)

type RgbColor = [number, number, number]

function parseHexColor(hex: string): RgbColor {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16)
	]
}

let gradientStartColor = parseHexColor(gradientStartPicker.value)
let gradientEndColor = parseHexColor(gradientEndPicker.value)
let gradientStartOpacity = Number(gradientStartOpacitySlider.value) / 100
let gradientEndOpacity = Number(gradientEndOpacitySlider.value) / 100

function updateFftResolution() {
	fftSize = 2 ** Number(fftResolution.value)
	fftResolutionValue.textContent = `${fftSize.toLocaleString()} samples`

	if (analyser) {
		analyser.fftSize = fftSize
		spectrum = new Float32Array(analyser.frequencyBinCount)
		draw()
	}
}

let audioContext: AudioContext | undefined
let stream: MediaStream | undefined
let source: MediaStreamAudioSourceNode | undefined
let analyser: AnalyserNode | undefined
let silentOutput: GainNode | undefined
let spectrum: Float32Array<ArrayBuffer> | undefined
let animationFrame = 0
let animationRunning = false
let hoveredBandIndex: number | undefined
let hoveredFrequency: number | undefined
let pointerPosition: { x: number; y: number } | undefined
let gainDb = 0

fftResolution.addEventListener('input', updateFftResolution)
visualGain.addEventListener('input', () => {
	gainDb = Number(visualGain.value)
	visualGainValue.textContent = `${gainDb > 0 ? '+' : ''}${gainDb} dB`
	draw()
})
gradientStartPicker.addEventListener('input', () => {
	gradientStartColor = parseHexColor(gradientStartPicker.value)
	draw()
})
gradientEndPicker.addEventListener('input', () => {
	gradientEndColor = parseHexColor(gradientEndPicker.value)
	draw()
})
gradientStartOpacitySlider.addEventListener('input', () => {
	gradientStartOpacity = Number(gradientStartOpacitySlider.value) / 100
	gradientStartOpacityValue.textContent = `${gradientStartOpacitySlider.value}%`
	draw()
})
gradientEndOpacitySlider.addEventListener('input', () => {
	gradientEndOpacity = Number(gradientEndOpacitySlider.value) / 100
	gradientEndOpacityValue.textContent = `${gradientEndOpacitySlider.value}%`
	draw()
})

function closeSettings() {
	settingsPanel.hidden = true
	drawerBackdrop.hidden = true
	openSettingsButton.setAttribute('aria-expanded', 'false')
	openSettingsButton.focus()
}

openSettingsButton.addEventListener('click', () => {
	settingsPanel.hidden = false
	drawerBackdrop.hidden = false
	openSettingsButton.setAttribute('aria-expanded', 'true')
	closeSettingsButton.focus()
})
closeSettingsButton.addEventListener('click', closeSettings)
drawerBackdrop.addEventListener('click', closeSettings)

document.addEventListener('keydown', event => {
	if (event.key === 'Escape' && !settingsPanel.hidden) {
		closeSettings()
		return
	}

	if (event.key !== 'Tab' || settingsPanel.hidden) {
		return
	}

	const focusable = settingsPanel.querySelectorAll<HTMLElement>(
		'button:not(:disabled), input:not(:disabled)'
	)
	const first = focusable[0]
	const last = focusable[focusable.length - 1]

	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault()
		last.focus()
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault()
		first.focus()
	}
})

function getOuterRadius(width: number, height: number) {
	return Math.min(width, height) * 0.39
}

function getFrequencyPosition(
	frequency: number,
	width: number,
	height: number,
	radiusOffset = 0
) {
	const octavePosition = Math.max(0, Math.min(
		octaveCount,
		Math.log2(frequency / minFrequency)
	))
	const fraction = octavePosition % 1
	const angle = -Math.PI / 2 + fraction * Math.PI * 2
	const outerRadius = getOuterRadius(width, height)
	const innerRadius = Math.max(5, outerRadius * 0.025)
	const radius = Math.max(
		0,
		innerRadius + (outerRadius - innerRadius) * (octavePosition / octaveCount) - radiusOffset
	)

	return {
		x: width / 2 + Math.cos(angle) * radius,
		y: height / 2 + Math.sin(angle) * radius
	}
}

function getBandThickness(outerRadius: number) {
	return (outerRadius - Math.max(5, outerRadius * 0.025)) / octaveCount
}

function getBandPolygon(index: number, width: number, height: number): BandPolygon {
	const lowFrequency = minFrequency * 2 ** (index / bandsPerOctave)
	const highFrequency = Math.min(
		maxFrequency,
		minFrequency * 2 ** ((index + 1) / bandsPerOctave)
	)
	const bandThickness = getBandThickness(getOuterRadius(width, height))

	return [
		getFrequencyPosition(lowFrequency, width, height),
		getFrequencyPosition(highFrequency, width, height),
		getFrequencyPosition(highFrequency, width, height, bandThickness),
		getFrequencyPosition(lowFrequency, width, height, bandThickness)
	]
}

function traceBandPolygon(polygon: BandPolygon) {
	context.beginPath()
	context.moveTo(polygon[0].x, polygon[0].y)
	for (let index = 1; index < polygon.length; index += 1) {
		context.lineTo(polygon[index].x, polygon[index].y)
	}
	context.closePath()
}

function containsPoint(polygon: BandPolygon, x: number, y: number) {
	let inside = false

	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
		const currentPoint = polygon[index]
		const previousPoint = polygon[previous]
		const crossesY = (currentPoint.y > y) !== (previousPoint.y > y)
		if (crossesY && x < (previousPoint.x - currentPoint.x)
			* (y - currentPoint.y) / (previousPoint.y - currentPoint.y) + currentPoint.x) {
			inside = !inside
		}
	}

	return inside
}

function getBandLevel(index: number, data: Float32Array<ArrayBuffer>, sampleRate: number) {
	const lowFrequency = minFrequency * 2 ** (index / bandsPerOctave)
	const highFrequency = minFrequency * 2 ** ((index + 1) / bandsPerOctave)
	if (lowFrequency >= sampleRate / 2) {
		return 0
	}

	const binWidth = sampleRate / fftSize
	const firstBin = Math.max(1, Math.floor(lowFrequency / binWidth))
	const lastBin = Math.min(data.length - 1, Math.ceil(highFrequency / binWidth))
	let peakDb = -Infinity

	for (let bin = firstBin; bin <= lastBin; bin += 1) {
		peakDb = Math.max(peakDb, data[bin])
	}

	if (peakDb === -Infinity) {
		const nearestBin = Math.min(data.length - 1, Math.max(1, Math.round(
			Math.sqrt(lowFrequency * highFrequency) / binWidth
		)))
		peakDb = data[nearestBin]
	}

	return Math.max(0, Math.min(1, (peakDb + gainDb + 90) / 65))
}

function formatFrequency(frequency: number) {
	return frequency >= 1_000
		? `${Number((frequency / 1_000).toPrecision(3))} kHz`
		: `${Number(frequency.toPrecision(4))} Hz`
}

function getNearestPitch(frequency: number) {
	const midiNote = Math.round(69 + 12 * Math.log2(frequency / 440))
	const cents = Math.round((69 + 12 * Math.log2(frequency / 440) - midiNote) * 100)
	const pitchClass = pitchClasses[((midiNote % 12) + 12) % 12]
	const octave = Math.floor(midiNote / 12) - 1
	const centsLabel = cents > 0 ? `+${cents}` : `${cents}`

	return `${pitchClass}${octave} ${centsLabel} cents`
}

function drawPitchClassLabels(width: number, height: number, outerRadius: number) {
	const centerX = width / 2
	const centerY = height / 2
	const firstClassAngle = -Math.PI / 2 + Math.log2(c4Frequency / minFrequency) * Math.PI * 2
	const labelRadius = outerRadius + 14

	context.font = '11px system-ui, sans-serif'
	context.fillStyle = 'rgba(188, 208, 235, 0.88)'
	context.textBaseline = 'middle'

	for (let pitchClass = 0; pitchClass < pitchClasses.length; pitchClass += 1) {
		const angle = firstClassAngle + (pitchClass / 12) * Math.PI * 2
		const x = centerX + Math.cos(angle) * labelRadius
		const y = centerY + Math.sin(angle) * labelRadius
		const tickStartX = centerX + Math.cos(angle) * outerRadius
		const tickStartY = centerY + Math.sin(angle) * outerRadius
		const tickEndX = centerX + Math.cos(angle) * (outerRadius + 5)
		const tickEndY = centerY + Math.sin(angle) * (outerRadius + 5)

		context.beginPath()
		context.moveTo(tickStartX, tickStartY)
		context.lineTo(tickEndX, tickEndY)
		context.strokeStyle = 'rgba(188, 208, 235, 0.65)'
		context.lineWidth = 1
		context.stroke()

		context.textAlign = Math.cos(angle) > 0.4 ? 'left' : Math.cos(angle) < -0.4 ? 'right' : 'center'
		context.fillText(pitchClasses[pitchClass], x, y)
	}
}

function updateTooltip() {
	if (hoveredBandIndex === undefined || !hoveredFrequency || !pointerPosition) {
		tooltip.style.display = 'none'
		return
	}

	tooltip.textContent = `${formatFrequency(hoveredFrequency)} · ${getNearestPitch(hoveredFrequency)}`
	tooltip.style.left = `${pointerPosition.x}px`
	tooltip.style.top = `${pointerPosition.y}px`
	tooltip.style.display = 'block'
}

function getGradientColor(level: number) {
	const channels = gradientStartColor.map((start, index) =>
		Math.round(start + (gradientEndColor[index] - start) * level)
	)
	const opacity = gradientStartOpacity + (gradientEndOpacity - gradientStartOpacity) * level
	return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${opacity})`
}

function draw() {
	const width = canvas.clientWidth
	const height = canvas.clientHeight
	const outerRadius = getOuterRadius(width, height)

	context.clearRect(0, 0, width, height)
	drawPitchClassLabels(width, height, outerRadius)

	if (spectrum && audioContext) {
		analyser?.getFloatFrequencyData(spectrum)
	}

	for (let index = 0; index < bandCount; index += 1) {
		const level = spectrum && audioContext
			? getBandLevel(index, spectrum, audioContext.sampleRate)
			: 0
		const polygon = getBandPolygon(index, width, height)

		traceBandPolygon(polygon)
		context.fillStyle = getGradientColor(level)
		context.fill()
	}

	if (hoveredBandIndex !== undefined) {
		traceBandPolygon(getBandPolygon(hoveredBandIndex, width, height))
		context.strokeStyle = '#ffffff'
		context.lineWidth = 2
		context.stroke()
	}

	updateTooltip()
}

canvas.addEventListener('pointermove', event => {
	const bounds = canvas.getBoundingClientRect()
	const x = event.clientX - bounds.left
	const y = event.clientY - bounds.top
	const width = canvas.clientWidth
	const height = canvas.clientHeight
	let hoveredIndex: number | undefined

	for (let index = 0; index < bandCount; index += 1) {
		if (containsPoint(getBandPolygon(index, width, height), x, y)) {
			hoveredIndex = index
			break
		}
	}

	if (hoveredIndex === undefined) {
		hoveredBandIndex = undefined
		hoveredFrequency = undefined
		pointerPosition = undefined
	} else {
		hoveredBandIndex = hoveredIndex
		hoveredFrequency = Math.min(
			maxFrequency,
			minFrequency * 2 ** ((hoveredIndex + 0.5) / bandsPerOctave)
		)
		pointerPosition = { x, y }
	}

	draw()
})

canvas.addEventListener('pointerleave', () => {
	hoveredBandIndex = undefined
	hoveredFrequency = undefined
	pointerPosition = undefined
	draw()
})

function animate() {
	if (!animationRunning) {
		return
	}

	draw()
	animationFrame = requestAnimationFrame(animate)
}

function startAnimation() {
	if (animationRunning) {
		return
	}

	animationRunning = true
	animationFrame = requestAnimationFrame(animate)
}

function setMicrophoneButtonActive(active: boolean) {
	button.dataset.active = String(active)
	button.setAttribute('aria-pressed', String(active))
	const label = active ? 'Mute microphone' : 'Start microphone'
	button.setAttribute('aria-label', label)
	button.title = label
	microphoneHint.hidden = active || button.disabled
}

function isMicrophoneActive() {
	const audioTracks = stream?.getAudioTracks() ?? []
	return audioContext?.state === 'running'
		&& audioTracks.length > 0
		&& audioTracks.every(track =>
			track.readyState === 'live' && track.enabled && !track.muted
		)
}

function updateMicrophoneButton() {
	const active = isMicrophoneActive()
	setMicrophoneButtonActive(active)

	if (active) {
		microphoneHint.textContent = defaultMicrophoneHint
	} else if (stream) {
		microphoneHint.textContent = `${defaultMicrophoneHint} Microphone is muted or unavailable.`
	}
}

function resizeCanvas() {
	const pixelRatio = window.devicePixelRatio || 1
	const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio))
	const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio))

	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width
		canvas.height = height
	}

	context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
	startAnimation()
}

function releaseAudio() {
	setMicrophoneButtonActive(false)
	animationRunning = false
	cancelAnimationFrame(animationFrame)
	animationFrame = 0
	source?.disconnect()
	source = undefined
	silentOutput?.disconnect()
	silentOutput = undefined
	analyser = undefined
	spectrum = undefined

	stream?.getTracks().forEach(track => track.stop())
	stream = undefined

	const previousContext = audioContext
	audioContext = undefined
	if (previousContext && previousContext.state !== 'closed') {
		void previousContext.close().catch(error => {
			console.error('Unable to close the audio context:', error)
		})
	}
}

button.addEventListener('click', async () => {
	if (stream && isMicrophoneActive()) {
		releaseAudio()
		draw()
		return
	}
	if (stream) {
		releaseAudio()
	}

	button.disabled = true
	microphoneHint.hidden = true

	try {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('Microphone access requires a supported browser on HTTPS or localhost.')
		}

		stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false
			}
		})
		for (const track of stream.getAudioTracks()) {
			track.addEventListener('mute', updateMicrophoneButton)
			track.addEventListener('unmute', updateMicrophoneButton)
			track.addEventListener('ended', updateMicrophoneButton)
		}
		audioContext = new AudioContext()
		audioContext.addEventListener('statechange', updateMicrophoneButton)
		await audioContext.resume()

		analyser = audioContext.createAnalyser()
		analyser.fftSize = fftSize
		analyser.smoothingTimeConstant = 0.72
		source = audioContext.createMediaStreamSource(stream)
		source.connect(analyser)
		silentOutput = audioContext.createGain()
		silentOutput.gain.value = 0
		analyser.connect(silentOutput)
		silentOutput.connect(audioContext.destination)
		spectrum = new Float32Array(analyser.frequencyBinCount)

		updateMicrophoneButton()
		startAnimation()
	} catch (error) {
		releaseAudio()
		const message = error instanceof Error ? error.message : String(error)
		console.error('Unable to start the microphone visualizer:', error)
		microphoneHint.textContent = `${defaultMicrophoneHint} Unable to start microphone: ${message}`
	} finally {
		button.disabled = false
		updateMicrophoneButton()
	}
})

window.addEventListener('resize', resizeCanvas)
resizeCanvas()
