import React, {
    useMemo,
    useRef,
    useState,
    useLayoutEffect,
    useCallback,
} from "react"
import {
    motion,
    useMotionValue,
    useTransform,
    useAnimationFrame,
    useAnimation,
    MotionValue,
} from "framer-motion"
import { ControlType, addPropertyControls } from "framer"

/* -------------------------------------------------------------------------- */
/* Types */
/* -------------------------------------------------------------------------- */

type ResponsiveImageSource = {
    src: string
    srcSet?: string
    sizes?: string
    alt?: string
    width?: number
    height?: number
}

type ImageSource = string | ResponsiveImageSource

export type ImageType = {
    src: ImageSource
    alt?: string
    width?: number
    height?: number
    href?: string
    cursorVariant?: string // "Image1", "Image2", etc. for cursor variant
    hoverText?: string // for fallback or reference
}

export interface SpringPhysics {
    stiffness: number
    damping: number
    mass: number
}

export interface ScrollPhysics {
    power?: number
    damping: number
    stopThreshold: number
    stiffness: number
    mass: number
    useSpring: boolean
}

export interface EffectSettings {
    opacity: number
    scale: number
    rotate: number
    rotateMode: "2D" | "3D"
    skewX: number
    skewY: number
    offsetX: number
    offsetY: number
}

export interface DragStateEffects {
    scale: number
    zoomOutAmount: number
    zoomTransitionSpeed: number
}

export interface SkewedScrollProps {
    images: ImageType[]
    numCards: number
    defaultCardWidth: number
    defaultCardHeight: number
    forceDefaultSize: boolean
    gap: number
    skew: number
    diagonalSpread: number
    diagonalAngle: number
    xOffset: number
    scrollPhysics: ScrollPhysics
    flingMultiplier: number
    dragSensitivity: number
    entrance: boolean
    cardOpacity: number
    style?: React.CSSProperties
    hoverEffects: EffectSettings
    hoverTransition?: any
    pressEffects: EffectSettings
    dragStateEffects: DragStateEffects
    zoomOutSpring: SpringPhysics
    zoomInSpring: SpringPhysics
    baseVelocity: number
    overflowVisible?: boolean
    enableDynamicCursor?: boolean
    cursorTransition?: any
    debugSizing?: boolean
    sizeDampening?: number
    maxPositionWidth?: number
    maxPositionHeight?: number
}

interface CardProps {
    img: ImageType
    idx: number
    total: number
    cardW: number
    cardH: number
    gap: number
    spread: number
    containerW: number
    containerH: number
    xOffset: number
    diagonalAngle: number
    progress: MotionValue<number>
    hoverEffects: EffectSettings
    pressEffects: EffectSettings
    hoverTransition?: any
    opacity: number
    onCursorEnter?: (variant: string, hoverText?: string) => void
    onCursorLeave?: () => void
    enableDynamicCursor?: boolean
    cursorTransition?: any
    sizeDampening?: number
    maxPositionWidth?: number
    maxPositionHeight?: number
    defaultCardWidth?: number
    defaultCardHeight?: number
}

interface Dimensions {
    w: number
    h: number
}

interface CardData {
    key: string
    img: ImageType
    idx: number
    cardW: number
    cardH: number
}

interface LoadingState {
    isLoading: boolean
    progress: number
    loadedImages: Set<number>
    totalImages: number
}

interface DragVariants {
    rest: {
        scale: number
        skewY: number
        transition: {
            type: string
            stiffness: number
            damping: number
            mass: number
        }
    }
    drag: {
        scale: number
        skewY: number
        transition: {
            type: string
            stiffness: number
            damping: number
            mass: number
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Physics Calculations */
/* -------------------------------------------------------------------------- */

function applySpringPhysics(config: {
    currentVelocity: number
    targetVelocity: number
    stiffness: number
    damping: number
    mass: number
    deltaTime: number
}): number {
    const {
        currentVelocity,
        targetVelocity,
        stiffness,
        damping,
        mass,
        deltaTime,
    } = config
    const velocityDifference = targetVelocity - currentVelocity
    const springForce = velocityDifference * stiffness
    const dampingForce = currentVelocity * damping
    const acceleration = (springForce - dampingForce) / mass

    return currentVelocity + acceleration * (deltaTime / 1000)
}

/* -------------------------------------------------------------------------- */
/* Image Helpers */
/* -------------------------------------------------------------------------- */

type ResolvedImageSource = {
    src: string
    srcSet?: string
    sizes?: string
    alt?: string
}

function resolveImageSource(
    source: ImageSource | undefined
): ResolvedImageSource | null {
    if (!source) return null

    if (typeof source === "string") {
        return source ? { src: source } : null
    }

    if (typeof source === "object" && typeof source.src === "string") {
        return {
            src: source.src,
            srcSet: source.srcSet,
            sizes: source.sizes,
            alt: source.alt,
        }
    }

    return null
}

function getImageAltText(image: ImageType, fallback: string): string {
    if (typeof image.alt === "string" && image.alt.trim().length > 0) {
        return image.alt
    }

    const resolved = resolveImageSource(image.src)
    if (resolved?.alt && resolved.alt.trim().length > 0) {
        return resolved.alt
    }

    return fallback
}

/* -------------------------------------------------------------------------- */
/* Position Calculations */
/* -------------------------------------------------------------------------- */

// Dampening function to reduce position impact of large size variations
function getDampenedSize(
    actualSize: number,
    baseSize: number,
    dampening: number = 0.5
): number {
    // dampening = 0 means use base size only (uniform positioning)
    // dampening = 1 means use actual size (current behavior)
    // dampening = 0.3 means 30% of size variation affects position
    return baseSize + (actualSize - baseSize) * dampening
}

// Apply max constraints to prevent extreme positioning
function getConstrainedSize(size: number, maxSize?: number): number {
    return maxSize ? Math.min(size, maxSize) : size
}

function calculateScrollableWidth(diagonalSpread: number): number {
    return 2000 * diagonalSpread
}

function calculateCardPosition(config: {
    progress: number
    idx: number
    total: number
    containerW: number
    containerH: number
    cardW: number
    cardH: number
    gap: number
    spread: number
    xOffset: number
}): { x: number; y: number; zIndex: number } {
    const {
        progress,
        idx,
        total,
        containerW,
        containerH,
        cardW,
        cardH,
        gap,
        spread,
        xOffset,
    } = config
    const loop = (progress + idx / total) % 1

    // X position
    const xRange = [
        containerW + (cardW + gap) * spread - xOffset,
        -(cardW + gap) * spread - xOffset,
    ]
    const x = xRange[0] + (xRange[1] - xRange[0]) * loop

    // Y position
    const yRange = [-cardH - gap * spread, containerH + cardH + gap * spread]
    const y = yRange[0] + (yRange[1] - yRange[0]) * loop

    // Z-index
    const zIndex = Math.floor(loop * total * 10) / 10

    return { x, y, zIndex }
}

function calculateCardOpacity(config: {
    progress: number
    idx: number
    total: number
    baseOpacity: number
    spread: number
}): number {
    const { progress, idx, total, baseOpacity, spread } = config
    const loop = (progress + idx / total) % 1
    const fadeEdge = Math.min(0.15, 0.1 * spread) // Inlined calculateFadeEdge

    const opacityPoints = [0, fadeEdge, 1 - fadeEdge, 1]
    const opacityValues = [0, baseOpacity, baseOpacity, 0]

    for (let i = 0; i < opacityPoints.length - 1; i++) {
        if (loop >= opacityPoints[i] && loop <= opacityPoints[i + 1]) {
            const t =
                (loop - opacityPoints[i]) /
                (opacityPoints[i + 1] - opacityPoints[i])
            return (
                opacityValues[i] + (opacityValues[i + 1] - opacityValues[i]) * t
            )
        }
    }

    return 0
}

/* -------------------------------------------------------------------------- */
/* Data Processing */
/* -------------------------------------------------------------------------- */

function generateCardData(
    images: ImageType[],
    numCards: number,
    forceDefaultSize: boolean,
    defaultCardWidth: number,
    defaultCardHeight: number
): CardData[] {
    const validImages = Array.isArray(images) ? images : []
    if (validImages.length === 0) return []

    return Array.from({ length: numCards })
        .map((_, i) => {
            const imgData = validImages[i % validImages.length]
            if (!imgData) return null

            const resolvedSource = resolveImageSource(imgData.src)
            if (!resolvedSource?.src) return null

            // Determine card dimensions
            let cardW: number
            let cardH: number

            if (forceDefaultSize) {
                // Use default sizes when forced
                cardW = defaultCardWidth
                cardH = defaultCardHeight
            } else {
                // Use custom sizes if available, otherwise fall back to defaults
                cardW =
                    typeof imgData.width === "number" && imgData.width > 0
                        ? imgData.width
                        : defaultCardWidth
                cardH =
                    typeof imgData.height === "number" && imgData.height > 0
                        ? imgData.height
                        : defaultCardHeight
            }

            return {
                key: `card-${i}`,
                img: imgData,
                idx: i,
                cardW,
                cardH,
            }
        })
        .filter(Boolean) as CardData[]
}

/* -------------------------------------------------------------------------- */
/* Image Loading Hook */
/* -------------------------------------------------------------------------- */

function useImageLoader(images: ImageType[], numCards: number) {
    const [loadingState, setLoadingState] = useState<LoadingState>({
        isLoading: true,
        progress: 0,
        loadedImages: new Set(),
        totalImages: 0,
    })

    const loadedImageCache = useRef<Set<string>>(new Set())

    useLayoutEffect(() => {
        if (!images || images.length === 0) {
            setLoadingState({
                isLoading: false,
                progress: 100,
                loadedImages: new Set(),
                totalImages: 0,
            })
            return
        }

        // Calculate needed images
        const neededImageIndices = new Set<number>()
        for (let i = 0; i < numCards; i++) {
            neededImageIndices.add(i % images.length)
        }

        const neededImages = Array.from(neededImageIndices)
        const totalNeeded = neededImages.length

        setLoadingState((prev) => ({
            ...prev,
            isLoading: true,
            progress: 0,
            totalImages: totalNeeded,
            loadedImages: new Set(),
        }))

        // Load ALL images - no batches, no progressive loading
        const loadAllImages = neededImages.map((imageIndex) => {
            return new Promise<void>((resolve) => {
                const img = images[imageIndex]
                const resolvedSource = resolveImageSource(img?.src)
                if (!resolvedSource?.src) {
                    resolve()
                    return
                }

                const cacheKey = resolvedSource.src

                if (loadedImageCache.current.has(cacheKey)) {
                    setLoadingState((prev) => {
                        const newLoaded = new Set(prev.loadedImages).add(
                            imageIndex
                        )
                        return {
                            ...prev,
                            loadedImages: newLoaded,
                            progress: (newLoaded.size / prev.totalImages) * 100,
                        }
                    })
                    resolve()
                    return
                }

                const imageElement = new Image()
                imageElement.onload = () => {
                    loadedImageCache.current.add(cacheKey)
                    setLoadingState((prev) => {
                        const newLoaded = new Set(prev.loadedImages).add(
                            imageIndex
                        )
                        return {
                            ...prev,
                            loadedImages: newLoaded,
                            progress: (newLoaded.size / prev.totalImages) * 100,
                        }
                    })
                    resolve()
                }
                imageElement.onerror = () => {
                    setLoadingState((prev) => {
                        const newLoaded = new Set(prev.loadedImages).add(
                            imageIndex
                        )
                        return {
                            ...prev,
                            loadedImages: newLoaded,
                            progress: (newLoaded.size / prev.totalImages) * 100,
                        }
                    })
                    resolve()
                }

                if (resolvedSource.srcSet) {
                    imageElement.srcset = resolvedSource.srcSet
                }

                imageElement.src = resolvedSource.src
            })
        })

        // Wait for ALL images, then show gallery
        Promise.all(loadAllImages).then(() => {
            setLoadingState((prev) => ({
                ...prev,
                isLoading: false, // Show gallery only when 100% ready
            }))
        })
    }, [images, numCards])

    return loadingState
}

/* -------------------------------------------------------------------------- */
/* Hooks */
/* -------------------------------------------------------------------------- */

function useScrollLayout() {
    const containerRef = useRef<HTMLDivElement>(null)
    const [dimensions, setDimensions] = useState<Dimensions>({ w: 0, h: 0 })

    useLayoutEffect(() => {
        const updateDimensions = () => {
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect()
                setDimensions({
                    w: Math.max(rect.width, 100),
                    h: Math.max(rect.height, 100),
                })
            }
        }

        updateDimensions()

        const resizeObserver = new ResizeObserver(updateDimensions)
        if (containerRef.current) {
            resizeObserver.observe(containerRef.current)
        }

        return () => resizeObserver.disconnect()
    }, [])

    return { containerRef, dimensions }
}

function useScrollPhysics(
    scrollPhysics: ScrollPhysics,
    diagonalSpread: number,
    baseVelocity: number
) {
    const isDragging = useRef(false)
    const isAnimating = useRef(false)
    const idleTimeout = useRef<number | null>(null)
    const position = useMotionValue(0)
    const velocity = useMotionValue(0)

    const scrollableWidth = calculateScrollableWidth(diagonalSpread)
    const wrappedProgress = useTransform(position, (v) => {
        const scrollable = scrollableWidth
        return (((v % scrollable) + scrollable) % scrollable) / scrollable
    })

    // Function to stop animation
    const stopAnimation = useCallback(() => {
        isAnimating.current = false
        if (idleTimeout.current) {
            clearTimeout(idleTimeout.current)
            idleTimeout.current = null
        }
    }, [])

    // Function to start animation
    const startAnimation = useCallback(() => {
        if (!isAnimating.current) {
            isAnimating.current = true
        }
        // Clear any pending stop timeout
        if (idleTimeout.current) {
            clearTimeout(idleTimeout.current)
            idleTimeout.current = null
        }
    }, [])

    // Enhanced keyboard navigation support (Phase 5)
    useLayoutEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const currentVelocity = velocity.get()
            const currentPosition = position.get()

            switch (e.code) {
                case "ArrowLeft":
                    e.preventDefault()
                    velocity.set(currentVelocity - 20)
                    startAnimation()
                    break

                case "ArrowRight":
                    e.preventDefault()
                    velocity.set(currentVelocity + 20)
                    startAnimation()
                    break

                case "Space":
                    e.preventDefault()
                    // Fast scroll like drag speed - use higher multiplier
                    const spaceVelocity = e.shiftKey ? -60 : 60 // Shift+Space for reverse
                    velocity.set(currentVelocity + spaceVelocity)
                    startAnimation()
                    break

                // Phase 5: Enhanced navigation keys
                case "Home":
                    e.preventDefault()
                    position.set(0)
                    velocity.set(0)
                    startAnimation()
                    break

                case "End":
                    e.preventDefault()
                    const scrollableWidth =
                        calculateScrollableWidth(diagonalSpread)
                    position.set(scrollableWidth * 0.8) // Go to near end
                    velocity.set(0)
                    startAnimation()
                    break

                case "PageUp":
                    e.preventDefault()
                    velocity.set(currentVelocity - 40)
                    startAnimation()
                    break

                case "PageDown":
                    e.preventDefault()
                    velocity.set(currentVelocity + 40)
                    startAnimation()
                    break
            }
        }

        window.addEventListener("keydown", handleKeyDown)
        return () => window.removeEventListener("keydown", handleKeyDown)
    }, [velocity, position, startAnimation, diagonalSpread])

    // Performance optimization refs
    const lastFrameTime = useRef(0)
    const frameCount = useRef(0)

    useAnimationFrame((time, delta) => {
        // Skip if not animating or dragging
        if (!isAnimating.current && !isDragging.current) return

        // Skip if dragging (handled by interaction system)
        if (isDragging.current) return

        // Skip frames if running too slow (performance optimization)
        frameCount.current++
        if (frameCount.current % 2 === 0 && delta > 32) {
            return // Skip every other frame on slow devices
        }

        // Cap delta to prevent large jumps
        const cappedDelta = Math.min(delta, 32) // Cap at ~30fps minimum
        let moveBy = baseVelocity * (cappedDelta / 1000)

        const currentVelocity = velocity.get()
        let newVelocity: number

        // Performance monitoring (development only)
        if (
            typeof process !== "undefined" &&
            process.env?.NODE_ENV === "development"
        ) {
            const frameRate = 1000 / delta
            if (frameRate < 30) {
                console.warn(
                    `Low frame rate detected: ${frameRate.toFixed(1)} fps`
                )
            }
        }

        // Unified spring physics system
        newVelocity = applySpringPhysics({
            currentVelocity,
            targetVelocity: 0,
            stiffness: scrollPhysics.stiffness * 0.01,
            damping: scrollPhysics.damping * 0.01,
            mass: scrollPhysics.mass,
            deltaTime: cappedDelta,
        })

        // Check if we should stop animating
        const threshold = scrollPhysics.stopThreshold
        if (
            Math.abs(newVelocity) < threshold &&
            Math.abs(baseVelocity) < 0.01
        ) {
            velocity.set(0)
            // Set timeout to stop animation after idle period
            if (!idleTimeout.current) {
                idleTimeout.current = window.setTimeout(stopAnimation, 100)
            }
        } else {
            velocity.set(newVelocity)
            moveBy += newVelocity * (cappedDelta / 16)
            // Keep animating if there's significant movement
            startAnimation()
        }

        position.set(position.get() + moveBy)
    })

    // Cleanup on unmount
    useLayoutEffect(() => {
        return () => {
            if (idleTimeout.current) {
                clearTimeout(idleTimeout.current)
            }
        }
    }, [])

    return {
        position,
        velocity,
        wrappedProgress,
        isDragging,
        startAnimation,
        stopAnimation,
    }
}

function useScrollInteractions(
    position: MotionValue<number>,
    velocity: MotionValue<number>,
    isDragging: React.MutableRefObject<boolean>,
    dragSensitivity: number,
    flingMultiplier: number,
    skew: number,
    dragStateEffects: DragStateEffects,
    zoomOutSpring: SpringPhysics,
    zoomInSpring: SpringPhysics,
    startAnimation: () => void
) {
    const animationControls = useAnimation()

    const pressTimerRef = useRef<number | null>(null)
    const isPressedRef = useRef(false)
    const isZoomedRef = useRef(false)

    const activePointerIdRef = useRef<number | null>(null)
    const activePointerTypeRef = useRef<PointerEvent["pointerType"] | null>(
        null
    )
    const pointerStartRef = useRef({ x: 0, y: 0, time: 0 })
    const pointerLastRef = useRef({ x: 0, y: 0, time: 0, smoothedDelta: 0 })
    const pointerDownTimeRef = useRef(0)
    const isPointerDraggingRef = useRef(false)

    const dragVariants: DragVariants = useMemo(
        () => ({
            rest: {
                scale: 1,
                skewY: skew,
                transition: {
                    type: "spring",
                    ...zoomInSpring,
                    duration: dragStateEffects.zoomTransitionSpeed || 0.3,
                },
            },
            drag: {
                scale: dragStateEffects.zoomOutAmount || dragStateEffects.scale,
                skewY: skew,
                transition: {
                    type: "spring",
                    ...zoomOutSpring,
                    duration: dragStateEffects.zoomTransitionSpeed || 0.3,
                },
            },
        }),
        [skew, dragStateEffects, zoomInSpring, zoomOutSpring]
    )

    const clearPressTimer = useCallback(() => {
        if (pressTimerRef.current !== null) {
            clearTimeout(pressTimerRef.current)
            pressTimerRef.current = null
        }
    }, [])

    const resetPointerState = useCallback(() => {
        activePointerIdRef.current = null
        activePointerTypeRef.current = null
        pointerLastRef.current.smoothedDelta = 0
    }, [])

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            if (activePointerIdRef.current !== null) return

            isPressedRef.current = true
            isPointerDraggingRef.current = false
            isDragging.current = false

            activePointerIdRef.current = e.pointerId
            activePointerTypeRef.current = e.pointerType

            const nowPerformance = performance.now()
            const nowTime = Date.now()
            pointerDownTimeRef.current = nowPerformance
            pointerStartRef.current = {
                x: e.clientX,
                y: e.clientY,
                time: nowTime,
            }
            pointerLastRef.current = {
                x: e.clientX,
                y: e.clientY,
                time: nowTime,
                smoothedDelta: 0,
            }

            clearPressTimer()
            pressTimerRef.current = window.setTimeout(() => {
                if (isPressedRef.current && !isDragging.current) {
                    animationControls.start("drag")
                    isZoomedRef.current = true
                }
            }, 250)

            e.currentTarget.setPointerCapture(e.pointerId)
        },
        [animationControls, clearPressTimer, isDragging]
    )

    const handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (activePointerIdRef.current !== e.pointerId) return
            if (!isPressedRef.current) return

            const pointerType = activePointerTypeRef.current || "mouse"
            const deltaFromStartX = e.clientX - pointerStartRef.current.x
            const deltaFromStartY = e.clientY - pointerStartRef.current.y
            const movement = Math.hypot(deltaFromStartX, deltaFromStartY)
            const moveThreshold =
                pointerType === "touch" || pointerType === "pen" ? 10 : 15

            if (movement < moveThreshold && pressTimerRef.current !== null) {
                return
            }

            if (movement >= moveThreshold) {
                clearPressTimer()
            }

            if (!isZoomedRef.current && pressTimerRef.current !== null) {
                return
            }

            isPointerDraggingRef.current = true
            isDragging.current = true

            const moveDeltaX = e.clientX - pointerLastRef.current.x
            const moveDeltaY = e.clientY - pointerLastRef.current.y

            if (pointerType === "mouse") {
                const diagonalDelta = moveDeltaY - moveDeltaX
                const currentPos = position.get()
                const effectiveSensitivity = dragSensitivity * 0.5
                position.set(currentPos + diagonalDelta * effectiveSensitivity)
                pointerLastRef.current.smoothedDelta = 0
                pointerLastRef.current.time = Date.now()
            } else {
                const isHorizontalGesture =
                    Math.abs(deltaFromStartX) > Math.abs(deltaFromStartY) * 1.2
                const isVerticalGesture =
                    Math.abs(deltaFromStartY) > Math.abs(deltaFromStartX) * 1.2
                const isDiagonalGesture =
                    !isHorizontalGesture && !isVerticalGesture

                const now = Date.now()
                const timeDelta = Math.max(now - pointerLastRef.current.time, 1)
                const velocityMagnitude =
                    Math.hypot(moveDeltaX, moveDeltaY) / timeDelta

                const velocityMultiplier =
                    0.7 + Math.min(velocityMagnitude * 0.15, 0.3)
                const baseSensitivity = pointerType === "pen" ? 0.28 : 0.25
                const gestureMultiplier = isDiagonalGesture ? 1.05 : 1.0
                const adaptiveSensitivity =
                    dragSensitivity *
                    baseSensitivity *
                    velocityMultiplier *
                    gestureMultiplier

                const diagonalDelta = moveDeltaY - moveDeltaX
                const smoothingFactor = 0.3
                pointerLastRef.current.smoothedDelta =
                    pointerLastRef.current.smoothedDelta *
                        (1 - smoothingFactor) +
                    diagonalDelta * smoothingFactor

                const currentPos = position.get()
                position.set(
                    currentPos +
                        pointerLastRef.current.smoothedDelta *
                            adaptiveSensitivity
                )

                pointerLastRef.current.time = now

                if (pointerType !== "mouse") {
                    e.preventDefault()
                }
            }

            pointerLastRef.current.x = e.clientX
            pointerLastRef.current.y = e.clientY

            startAnimation()
        },
        [dragSensitivity, clearPressTimer, isDragging, position, startAnimation]
    )

    const handlePointerEnd = useCallback(
        (event: React.PointerEvent, cancelled = false) => {
            if (activePointerIdRef.current !== event.pointerId) return

            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
            }

            isPressedRef.current = false
            isDragging.current = false
            clearPressTimer()

            const pointerType = activePointerTypeRef.current || "mouse"

            if (!cancelled && isPointerDraggingRef.current) {
                const deltaX = event.clientX - pointerStartRef.current.x
                const deltaY = event.clientY - pointerStartRef.current.y

                if (pointerType === "mouse") {
                    const dragDuration = Math.max(
                        performance.now() - pointerDownTimeRef.current,
                        16
                    )
                    const velocityX = deltaX / dragDuration
                    const velocityY = deltaY / dragDuration
                    const diagonalVelocity =
                        (velocityY - velocityX) * flingMultiplier * 0.1
                    velocity.set(diagonalVelocity)
                    startAnimation()
                } else {
                    const now = Date.now()
                    const swipeTime = Math.max(
                        now - pointerStartRef.current.time,
                        50
                    )
                    const velocityX = (deltaX / swipeTime) * 1000
                    const velocityY = (deltaY / swipeTime) * 1000
                    const diagonalVelocity =
                        (velocityY - velocityX) * flingMultiplier * 0.005

                    const totalDelta = Math.hypot(deltaX, deltaY)
                    const isDiagonalSwipe =
                        totalDelta > 50 &&
                        Math.abs(deltaX - deltaY) < totalDelta * 0.3

                    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
                    const normalizedVelocity = Math.min(
                        Math.abs(diagonalVelocity) / 150,
                        1
                    )
                    const gestureBoost = isDiagonalSwipe ? 1.1 : 1.0
                    const dampening = 0.7
                    const flingForce =
                        diagonalVelocity *
                        easeOutCubic(normalizedVelocity) *
                        gestureBoost *
                        dampening

                    velocity.set(flingForce)
                    startAnimation()
                }
            }

            isPointerDraggingRef.current = false
            animationControls.start("rest")
            isZoomedRef.current = false

            resetPointerState()
        },
        [
            animationControls,
            clearPressTimer,
            flingMultiplier,
            isDragging,
            resetPointerState,
            startAnimation,
            velocity,
        ]
    )

    const handlePointerUp = useCallback(
        (e: React.PointerEvent) => handlePointerEnd(e, false),
        [handlePointerEnd]
    )

    const handlePointerCancel = useCallback(
        (e: React.PointerEvent) => handlePointerEnd(e, true),
        [handlePointerEnd]
    )

    useLayoutEffect(() => {
        return () => {
            clearPressTimer()
        }
    }, [clearPressTimer])

    return {
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handlePointerCancel,
        animationControls,
        dragVariants,
    }
}

/* -------------------------------------------------------------------------- */
/* Loading Screen Component */
/* -------------------------------------------------------------------------- */

const LoadingScreen = React.memo<{
    progress: number
    style?: React.CSSProperties
}>(({ progress, style }) => {
    return (
        <div
            style={{
                ...style,
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(0, 0, 0, 0.02)",
                backdropFilter: "blur(8px)",
                zIndex: 1000,
            }}
        >
            <div
                style={{
                    width: "120px",
                    height: "120px",
                    borderRadius: "60px",
                    backgroundColor: "rgba(255, 255, 255, 0.9)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",

                    border: "1px solid rgba(255, 255, 255, 0.2)",
                }}
            >
                {/* Progress Circle */}
                <svg width="60" height="60" style={{ marginBottom: "8px" }}>
                    <circle
                        cx="30"
                        cy="30"
                        r="25"
                        fill="none"
                        stroke="rgba(0, 0, 0, 0.1)"
                        strokeWidth="3"
                    />
                    <circle
                        cx="30"
                        cy="30"
                        r="25"
                        fill="none"
                        stroke="#007AFF"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeDasharray={`${2 * Math.PI * 25}`}
                        strokeDashoffset={`${2 * Math.PI * 25 * (1 - progress / 100)}`}
                        transform="rotate(-90 30 30)"
                        style={{
                            transition: "stroke-dashoffset 0.3s ease-out",
                        }}
                    />
                </svg>

                {/* Progress Text */}
                <div
                    style={{
                        fontSize: "14px",
                        fontWeight: "600",
                        color: "#333",
                        fontFamily: "system-ui, -apple-system, sans-serif",
                    }}
                >
                    {Math.round(progress)}%
                </div>
            </div>
        </div>
    )
})

LoadingScreen.displayName = "LoadingScreen"

/* -------------------------------------------------------------------------- */
/* Image Cache System */
/* -------------------------------------------------------------------------- */

interface ImageCacheItem {
    loaded: boolean
    error: boolean
    element?: HTMLImageElement
    timestamp: number
}

class ImageCache {
    private cache = new Map<string, ImageCacheItem>()
    private maxAge = 5 * 60 * 1000 // 5 minutes
    private maxSize = 50 // Maximum cached images

    get(src: string): ImageCacheItem | null {
        const item = this.cache.get(src)
        if (!item) return null

        // Check if expired
        if (Date.now() - item.timestamp > this.maxAge) {
            this.cache.delete(src)
            return null
        }

        return item
    }

    set(src: string, item: Omit<ImageCacheItem, "timestamp">): void {
        // Clean old entries if cache is full
        if (this.cache.size >= this.maxSize) {
            const oldestKey = Array.from(this.cache.entries()).sort(
                ([, a], [, b]) => a.timestamp - b.timestamp
            )[0][0]
            this.cache.delete(oldestKey)
        }

        this.cache.set(src, { ...item, timestamp: Date.now() })
    }

    preload(src: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const cached = this.get(src)
            if (cached?.loaded) {
                resolve()
                return
            }

            const img = new Image()
            img.onload = () => {
                this.set(src, { loaded: true, error: false, element: img })
                resolve()
            }
            img.onerror = () => {
                this.set(src, { loaded: false, error: true })
                reject()
            }
            img.src = src
        })
    }
}

// Global image cache instance
const imageCache = new ImageCache()

/* -------------------------------------------------------------------------- */
/* Progressive Image Component */
/* -------------------------------------------------------------------------- */

const ProgressiveImage: React.FC<{
    src: ImageSource
    alt?: string
    priority?: boolean
}> = React.memo(({ src, alt = "", priority: _priority = false }) => {
    const [loaded, setLoaded] = useState(false)
    const [error, setError] = useState(false)
    const imgRef = useRef<HTMLImageElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const resolvedSource = resolveImageSource(src)
    const altText = alt || resolvedSource?.alt || ""

    // Phase 4 cleanup: Direct image loading (intersection observer removed)
    useLayoutEffect(() => {
        if (!resolvedSource?.src) {
            setLoaded(false)
            setError(true)
            return
        }

        // Check cache first
        const cached = imageCache.get(resolvedSource.src)
        if (cached) {
            setLoaded(cached.loaded)
            setError(cached.error)
            return
        }

        // Load image and cache result
        const img = new Image()
        img.onload = () => {
            setLoaded(true)
            imageCache.set(resolvedSource.src, {
                loaded: true,
                error: false,
                element: img,
            })
        }
        img.onerror = () => {
            setError(true)
            imageCache.set(resolvedSource.src, { loaded: false, error: true })
        }
        if (resolvedSource.srcSet) {
            img.srcset = resolvedSource.srcSet
        }
        img.src = resolvedSource.src

        return () => {
            img.onload = null
            img.onerror = null
            // Additional cleanup for memory management
            if (imgRef.current) {
                imgRef.current.src = ""
            }
        }
    }, [resolvedSource?.src, resolvedSource?.srcSet])

    // Cleanup on unmount
    useLayoutEffect(() => {
        return () => {
            if (imgRef.current) {
                imgRef.current.src = ""
                imgRef.current.onload = null
                imgRef.current.onerror = null
            }
        }
    }, [])

    return (
        <div
            ref={containerRef}
            style={{
                width: "100%",
                height: "100%",
                position: "relative",
                overflow: "hidden",
                backgroundColor: "transparent",
            }}
        >
            {/* Placeholder gradient */}
            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    background: error
                        ? "linear-gradient(45deg, #ffcccc 25%, #ffdddd 50%, #ffcccc 75%)"
                        : "linear-gradient(45deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)",
                    backgroundSize: "40px 40px",
                    animation: loaded
                        ? "none"
                        : "shimmer 2s ease-in-out infinite",
                    opacity: loaded ? 0 : 1,
                    transition: "opacity 0.3s ease-out",
                }}
            />

            {/* Actual image */}
            <img
                ref={imgRef}
                src={resolvedSource?.src || ""}
                srcSet={resolvedSource?.srcSet}
                sizes={resolvedSource?.sizes}
                alt={altText}
                style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    opacity: loaded ? 1 : 0,
                    transition: "opacity 0.3s ease-out",
                }}
                onLoad={() => setLoaded(true)}
                onError={() => setError(true)}
            />

            {/* Error state */}
            {error && (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "12px",
                        color: "#999",
                        backgroundColor: "rgba(245, 245, 245, 0.5)",
                    }}
                >
                    Failed to load
                </div>
            )}
        </div>
    )
})

ProgressiveImage.displayName = "ProgressiveImage"

/* -------------------------------------------------------------------------- */
/* Components */
/* -------------------------------------------------------------------------- */

const SkewedCard = React.memo<CardProps>(
    ({
        img,
        idx,
        total,
        cardW,
        cardH,
        gap,
        spread,
        containerW,
        containerH,
        xOffset,
        diagonalAngle,
        progress,
        hoverEffects,
        pressEffects,
        hoverTransition,
        opacity,
        onCursorEnter,
        onCursorLeave,
        enableDynamicCursor,
        sizeDampening = 0.3,
        maxPositionWidth,
        maxPositionHeight,
        defaultCardWidth = 220,
        defaultCardHeight = 160,
    }) => {
        const Component = img.href ? motion.a : motion.div

        // Calculate dampened sizes for positioning to prevent huge gaps
        const positionW = getConstrainedSize(
            getDampenedSize(cardW, defaultCardWidth, sizeDampening),
            maxPositionWidth
        )
        const positionH = getConstrainedSize(
            getDampenedSize(cardH, defaultCardHeight, sizeDampening),
            maxPositionHeight
        )

        // Direct calculation from progress - maintains smooth real-time relationship
        const loop = useTransform(progress, (v) => (v + idx / total) % 1)

        // Convert angle to radians and calculate direction vector
        const angleRad = (diagonalAngle * Math.PI) / 180
        const dirX = Math.cos(angleRad)
        const dirY = Math.sin(angleRad)

        // Calculate the diagonal path length
        const diagonalLength = Math.sqrt(
            Math.pow(containerW + 2 * (positionW + gap) * spread, 2) +
                Math.pow(containerH + 2 * (positionH + gap) * spread, 2)
        )

        const x = useTransform(loop, (loopValue) => {
            // Center point of the container
            const centerX = containerW / 2 - xOffset
            // Calculate position along the diagonal line
            const progress = loopValue * 2 - 1 // Convert 0-1 to -1 to 1
            // Subtract half the card width to center the card
            return centerX - (dirX * diagonalLength * progress) / 2 - cardW / 2
        })

        const y = useTransform(loop, (loopValue) => {
            // Center point of the container
            const centerY = containerH / 2
            // Calculate position along the diagonal line
            const progress = loopValue * 2 - 1 // Convert 0-1 to -1 to 1
            // Subtract half the card height to center the card
            return centerY - (dirY * diagonalLength * progress) / 2 - cardH / 2
        })

        const z = useTransform(loop, (loopValue) => {
            return Math.floor(loopValue * total * 10) / 10
        })

        const fadeEdge = Math.min(0.15, 0.1 * spread) // Inlined calculateFadeEdge
        const cardOpacityTransform = useTransform(loop, (loopValue) => {
            const opacityPoints = [0, fadeEdge, 1 - fadeEdge, 1]
            const opacityValues = [0, opacity, opacity, 0]

            for (let i = 0; i < opacityPoints.length - 1; i++) {
                if (
                    loopValue >= opacityPoints[i] &&
                    loopValue <= opacityPoints[i + 1]
                ) {
                    const t =
                        (loopValue - opacityPoints[i]) /
                        (opacityPoints[i + 1] - opacityPoints[i])
                    return (
                        opacityValues[i] +
                        (opacityValues[i + 1] - opacityValues[i]) * t
                    )
                }
            }
            return 0
        })

        const rotationY = useTransform(loop, (loopValue) => {
            return (loopValue - 0.5) * 20
        })

        // Phase 4 cleanup: Virtualization removed for reliability
        const shouldRender = true // Always render all cards

        // Removed useMotionTemplate for GPU-friendly individual properties

        return (
            <Component
                style={{
                    position: "absolute",
                    width: cardW,
                    height: cardH,
                    x, // Framer handles as translateX
                    y, // Framer handles as translateY
                    rotateY: rotationY,
                    opacity: cardOpacityTransform,
                    zIndex: z,
                    willChange: "transform", // Only during interaction
                    transform: "translateZ(0)", // Force GPU layer
                    backfaceVisibility: "hidden", // Prevent flicker
                    transformStyle: "preserve-3d",
                    display: "block",
                    textDecoration: "none",
                    pointerEvents: "auto",
                }}
                href={img.href}
                target={img.href ? "_blank" : undefined}
                rel={img.href ? "noopener noreferrer" : undefined}
            >
                <motion.div
                    style={{
                        width: "100%",
                        height: "100%",
                        cursor: img.href ? "pointer" : "grab",
                        borderRadius: "0px",
                        // Additional GPU acceleration hints
                        transform: "translateZ(0)",
                        backfaceVisibility: "hidden",
                        willChange: "transform", // Only during hover/interactions
                        overflow: "hidden", // Ensure progressive image fits properly
                    }}
                    whileHover={{
                        opacity: hoverEffects.opacity,
                        scale: hoverEffects.scale,
                        rotate:
                            hoverEffects.rotateMode === "2D"
                                ? hoverEffects.rotate
                                : 0,
                        rotateY:
                            hoverEffects.rotateMode === "3D"
                                ? hoverEffects.rotate
                                : 0,
                        skewX: hoverEffects.skewX,
                        skewY: hoverEffects.skewY,
                        x: hoverEffects.offsetX,
                        y: hoverEffects.offsetY,
                        z: 20, // Slight forward movement for depth
                    }}
                    whileTap={{
                        opacity: pressEffects.opacity,
                        scale: pressEffects.scale,
                        rotate:
                            pressEffects.rotateMode === "2D"
                                ? pressEffects.rotate
                                : 0,
                        rotateY:
                            pressEffects.rotateMode === "3D"
                                ? pressEffects.rotate
                                : 0,
                        skewX: pressEffects.skewX,
                        skewY: pressEffects.skewY,
                        x: pressEffects.offsetX,
                        y: pressEffects.offsetY,
                    }}
                    transition={hoverTransition}
                    onMouseEnter={() => {
                        if (!enableDynamicCursor || !onCursorEnter) return

                        // Use cursorVariant if available, otherwise fallback to index-based variant
                        const variant = img.cursorVariant || `Image${idx + 1}`
                        const hoverText = img.hoverText || `Image ${idx + 1}`
                        onCursorEnter(variant, hoverText)
                    }}
                    onMouseLeave={() => {
                        if (!enableDynamicCursor || !onCursorLeave) return

                        onCursorLeave()
                    }}
                >
                    <ProgressiveImage
                        src={img.src}
                        alt={getImageAltText(img, `Card ${idx + 1}`)}
                        priority={idx < 5} // Priority load first 5 cards
                    />
                </motion.div>
            </Component>
        )
    },
    (prevProps, nextProps) => {
        // Custom comparison - only re-render if visual properties change
        return (
            prevProps.img.src === nextProps.img.src &&
            prevProps.cardW === nextProps.cardW &&
            prevProps.cardH === nextProps.cardH &&
            prevProps.opacity === nextProps.opacity &&
            prevProps.idx === nextProps.idx &&
            prevProps.total === nextProps.total &&
            prevProps.gap === nextProps.gap &&
            prevProps.spread === nextProps.spread &&
            prevProps.containerW === nextProps.containerW &&
            prevProps.containerH === nextProps.containerH &&
            prevProps.xOffset === nextProps.xOffset &&
            prevProps.hoverEffects === nextProps.hoverEffects &&
            prevProps.pressEffects === nextProps.pressEffects &&
            prevProps.enableDynamicCursor === nextProps.enableDynamicCursor &&
            prevProps.sizeDampening === nextProps.sizeDampening &&
            prevProps.maxPositionWidth === nextProps.maxPositionWidth &&
            prevProps.maxPositionHeight === nextProps.maxPositionHeight
            // Don't compare MotionValues (progress) - they update independently
            // Don't compare function references (onCursorEnter, onCursorLeave)
        )
    }
)

SkewedCard.displayName = "SkewedCard"

// Add shimmer animation CSS
const shimmerKeyframes = `
        @keyframes shimmer {
            0% { background-position: -200px 0; }
            100% { background-position: calc(200px + 100%) 0; }
        }
    `

// Inject CSS if not already present
if (
    typeof document !== "undefined" &&
    !document.getElementById("shimmer-styles")
) {
    const style = document.createElement("style")
    style.id = "shimmer-styles"
    style.textContent = shimmerKeyframes
    document.head.appendChild(style)
}

/* -------------------------------------------------------------------------- */
/* Phase 5: Fine-Tuning & Polish Components */
/* -------------------------------------------------------------------------- */

// Device-aware physics optimization
const getOptimizedPhysics = (): ScrollPhysics => {
    if (typeof navigator === "undefined") {
        // Default physics for server-side rendering
        return {
            power: 1.2,
            stiffness: 200,
            damping: 25,
            mass: 0.5,
            stopThreshold: 0.01,
            useSpring: true,
        }
    }

    const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent)
    const isLowEnd = navigator.hardwareConcurrency <= 4
    const isIOS = /iPhone|iPad/i.test(navigator.userAgent)

    return {
        power: 1.2,
        stiffness: isMobile ? (isIOS ? 190 : 180) : 200,
        damping: isLowEnd ? 30 : isMobile ? 28 : 25,
        mass: isMobile ? 0.6 : 0.5,
        stopThreshold: 0.01,
        useSpring: !isLowEnd, // Disable spring on very low-end devices
    }
}

function SkewedInfiniteScroll(props: SkewedScrollProps) {
    const {
        images,
        numCards,
        defaultCardWidth,
        defaultCardHeight,
        forceDefaultSize,
        gap,
        skew,
        diagonalSpread,
        diagonalAngle,
        xOffset,
        scrollPhysics,
        flingMultiplier,
        dragSensitivity,
        entrance,
        cardOpacity,
        style,
        hoverEffects,
        pressEffects,
        hoverTransition,
        dragStateEffects,
        zoomOutSpring,
        zoomInSpring,
        baseVelocity,
        overflowVisible,
        enableDynamicCursor,
        cursorTransition,
        debugSizing,
        sizeDampening,
        maxPositionWidth,
        maxPositionHeight,
    } = props

    const { containerRef, dimensions } = useScrollLayout()
    const optimizedScrollPhysics = useMemo(() => getOptimizedPhysics(), [])
    const resolvedScrollPhysics = useMemo(() => {
        return {
            ...optimizedScrollPhysics,
            ...scrollPhysics,
            power: scrollPhysics.power ?? optimizedScrollPhysics.power ?? 1.2,
        }
    }, [optimizedScrollPhysics, scrollPhysics])
    const loadingState = useImageLoader(images, numCards)

    // Cursor state management
    const [currentHoverText, setCurrentHoverText] = useState<string | null>(
        null
    )

    // Mouse position tracking for cursor following (using ref for performance)
    const mousePos = useRef({ x: 0, y: 0 })
    const cursorRef = useRef<HTMLDivElement>(null)

    // Cursor control functions
    const handleCursorEnter = useCallback(
        (_variant: string, hoverText?: string) => {
            if (!enableDynamicCursor) return

            setCurrentHoverText(hoverText || null)

            // Note: ComponentInstance doesn't have setVariant method
            // For native cursor integration, consider using:
            // 1. Framer cursor variants in design mode
            // 2. CSS custom properties: document.documentElement.style.setProperty('--cursor-variant', variant)
            // 3. Code overrides on the cursor component
        },
        [enableDynamicCursor]
    )

    const handleCursorLeave = useCallback(() => {
        if (!enableDynamicCursor) return

        setCurrentHoverText(null)
        // Reset to default variant
    }, [enableDynamicCursor])

    // Mouse move handler for cursor following (optimized for performance)
    const handleMouseMoveGlobal = useCallback(
        (e: MouseEvent) => {
            mousePos.current = { x: e.clientX, y: e.clientY }

            // Direct DOM manipulation to avoid React re-renders
            if (cursorRef.current && enableDynamicCursor && currentHoverText) {
                cursorRef.current.style.transform = `translate(${mousePos.current.x + 15}px, ${mousePos.current.y - 25}px)`
            }
        },
        [enableDynamicCursor, currentHoverText]
    )

    // Add mouse tracking effect
    useLayoutEffect(() => {
        window.addEventListener("mousemove", handleMouseMoveGlobal)
        return () =>
            window.removeEventListener("mousemove", handleMouseMoveGlobal)
    }, [handleMouseMoveGlobal])

    const { position, velocity, wrappedProgress, isDragging, startAnimation } =
        useScrollPhysics(resolvedScrollPhysics, diagonalSpread, baseVelocity)

    // Phase 5: Accessibility - track current position for screen readers
    const [currentCardIndex, setCurrentCardIndex] = useState(0)
    const [announceText, setAnnounceText] = useState("")

    useLayoutEffect(() => {
        const unsubscribe = wrappedProgress.on("change", (progress) => {
            const cardIndex = Math.round(progress * numCards) % numCards
            if (cardIndex !== currentCardIndex) {
                setCurrentCardIndex(cardIndex)
                setAnnounceText(`Image ${cardIndex + 1} of ${numCards}`)
            }
        })
        return unsubscribe
    }, [wrappedProgress, numCards, currentCardIndex])

    const {
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handlePointerCancel,
        animationControls,
        dragVariants,
    } = useScrollInteractions(
        position,
        velocity,
        isDragging,
        dragSensitivity,
        flingMultiplier,
        skew,
        dragStateEffects,
        zoomOutSpring,
        zoomInSpring,
        startAnimation
    )

    // Non-passive wheel event listener to properly prevent page scrolling
    useLayoutEffect(() => {
        const element = containerRef.current
        if (!element) return

        const handleWheelNonPassive = (e: WheelEvent) => {
            e.preventDefault() // This works with non-passive listener

            // Trigger scroll logic
            startAnimation()
            const scrollPower = (resolvedScrollPhysics.power || 1) * 0.1
            velocity.set(velocity.get() + e.deltaY * scrollPower)
        }

        // Add non-passive listener
        element.addEventListener("wheel", handleWheelNonPassive, {
            passive: false,
        })

        return () => {
            element.removeEventListener("wheel", handleWheelNonPassive)
        }
    }, [containerRef, resolvedScrollPhysics.power, velocity, startAnimation])

    // Mobile detection for optimized experience (SSR-safe)
    const isMobile = useMemo(() => {
        if (typeof window === "undefined" || typeof navigator === "undefined") {
            return false // Default to desktop on server
        }
        return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    }, [])

    const cardData = useMemo(
        () =>
            generateCardData(
                images,
                numCards,
                forceDefaultSize,
                defaultCardWidth,
                defaultCardHeight
            ),
        [
            images,
            numCards,
            forceDefaultSize,
            defaultCardWidth,
            defaultCardHeight,
        ]
    )

    // Phase 4 cleanup: Preloading system removed (was causing complexity without clear benefit)

    return (
        <motion.div
            ref={containerRef}
            role="region"
            aria-label="Diagonal scrolling gallery. Use arrow keys to navigate."
            tabIndex={0}
            style={{
                ...style,
                position: "relative",
                overflow: overflowVisible ? "visible" : "hidden",
                cursor: "grab",
                userSelect: "none",
                // Enhanced touch handling
                touchAction: "none", // Prevents all default touch behaviors
                WebkitTapHighlightColor: "transparent", // Remove tap highlight
                WebkitUserSelect: "none", // iOS Safari
                WebkitTouchCallout: "none", // iOS Safari
                WebkitUserDrag: "none", // Prevent drag on webkit
                overscrollBehavior: "none", // Prevent overscroll entirely
                // GPU acceleration for smooth scrolling container
                transform: "translateZ(0)",
                willChange: "contents", // Optimized for content changes
                backfaceVisibility: "hidden",
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
        >
            {/* Loading Screen - show until 100% ready */}
            {loadingState.isLoading && (
                <LoadingScreen progress={loadingState.progress} style={style} />
            )}

            {/* Gallery - only show when 100% ready */}
            {!loadingState.isLoading && (
                <motion.div
                    variants={dragVariants}
                    initial="rest"
                    animate={animationControls}
                    style={{
                        width: "100%",
                        height: "100%",
                        transformOrigin: "center center",
                    }}
                >
                    <motion.div
                        initial={entrance ? { opacity: 0 } : { opacity: 1 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.8, delay: 0.2 }}
                    >
                        {cardData.map((card) => (
                            <React.Fragment key={card.key}>
                                <SkewedCard
                                    img={card.img}
                                    idx={card.idx}
                                    total={numCards}
                                    cardW={card.cardW}
                                    cardH={card.cardH}
                                    gap={gap}
                                    spread={diagonalSpread}
                                    containerW={dimensions.w}
                                    containerH={dimensions.h}
                                    xOffset={xOffset}
                                    diagonalAngle={diagonalAngle}
                                    progress={wrappedProgress}
                                    hoverEffects={hoverEffects}
                                    pressEffects={pressEffects}
                                    hoverTransition={hoverTransition}
                                    opacity={cardOpacity}
                                    onCursorEnter={handleCursorEnter}
                                    onCursorLeave={handleCursorLeave}
                                    enableDynamicCursor={enableDynamicCursor}
                                    sizeDampening={sizeDampening}
                                    maxPositionWidth={maxPositionWidth}
                                    maxPositionHeight={maxPositionHeight}
                                    defaultCardWidth={defaultCardWidth}
                                    defaultCardHeight={defaultCardHeight}
                                />

                                {/* Debug Sizing Overlay */}
                                {debugSizing && (
                                    <motion.div
                                        style={{
                                            position: "absolute",
                                            top: 10 + card.idx * 25,
                                            left: 10,
                                            backgroundColor:
                                                "rgba(0, 0, 0, 0.8)",
                                            color: "white",
                                            padding: "4px 8px",
                                            fontSize: "12px",
                                            fontFamily: "monospace",
                                            borderRadius: "4px",
                                            pointerEvents: "none",
                                            zIndex: 1000,
                                        }}
                                    >
                                        Card {card.idx}: Visual {card.cardW}×
                                        {card.cardH}
                                        <br />
                                        Position:{" "}
                                        {Math.round(
                                            getConstrainedSize(
                                                getDampenedSize(
                                                    card.cardW,
                                                    defaultCardWidth,
                                                    sizeDampening || 0.3
                                                ),
                                                maxPositionWidth
                                            )
                                        )}
                                        ×
                                        {Math.round(
                                            getConstrainedSize(
                                                getDampenedSize(
                                                    card.cardH,
                                                    defaultCardHeight,
                                                    sizeDampening || 0.3
                                                ),
                                                maxPositionHeight
                                            )
                                        )}
                                        <br />
                                        {card.img.width && card.img.height
                                            ? `Custom: ${card.img.width}×${card.img.height}`
                                            : `Default: ${defaultCardWidth}×${defaultCardHeight}`}
                                        {forceDefaultSize ? " [FORCED]" : ""}
                                        <br />
                                        Dampening:{" "}
                                        {(sizeDampening || 0.3) * 100}%
                                    </motion.div>
                                )}
                            </React.Fragment>
                        ))}
                    </motion.div>
                </motion.div>
            )}

            {/* Phase 5: ARIA Live Region for Screen Readers */}
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                style={{
                    position: "absolute",
                    left: "-9999px",
                    width: "1px",
                    height: "1px",
                    overflow: "hidden",
                }}
            >
                {announceText &&
                    `Scrolling gallery: ${announceText}. Use arrow keys, Home, End, Page Up, or Page Down to navigate.`}
            </div>

            {/* Simple Cursor Text - follows mouse, changes per card, difference blending (optimized) */}
            {enableDynamicCursor && currentHoverText && (
                <div
                    ref={cursorRef}
                    style={{
                        position: "fixed",
                        left: 0,
                        top: 0,
                        pointerEvents: "none",
                        zIndex: 10000,
                        fontSize: "12px",
                        fontWeight: "500",
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        whiteSpace: "nowrap",
                        color: "white",
                        mixBlendMode: "difference" as const,
                        willChange: "transform",
                        transition: `transform ${cursorTransition?.duration || 0.1}s ${cursorTransition?.type === "spring" ? "cubic-bezier(0.25, 0.46, 0.45, 0.94)" : cursorTransition?.ease || "ease-out"}`,
                    }}
                >
                    {currentHoverText}
                </div>
            )}
        </motion.div>
    )
}

/* -------------------------------------------------------------------------- */
/* Default Props & Property Controls */
/* -------------------------------------------------------------------------- */

SkewedInfiniteScroll.defaultProps = {
    images: [],
    numCards: 100,
    defaultCardWidth: 220,
    defaultCardHeight: 160,
    forceDefaultSize: false,
    gap: 40,
    skew: -10,
    diagonalSpread: 1.2,
    diagonalAngle: 225,
    xOffset: 0,
    scrollPhysics: {
        power: 1.2,
        damping: 85,
        stopThreshold: 0.005,
        stiffness: 150,
        mass: 0.8,
        useSpring: true,
    },
    flingMultiplier: 80,
    dragSensitivity: 0.9,
    entrance: true,
    cardOpacity: 1,
    enableDynamicCursor: true,
    cursorTransition: {
        type: "spring",
        stiffness: 400,
        damping: 30,
    },
    debugSizing: false,
    sizeDampening: 0.3,
    maxPositionWidth: 300,
    maxPositionHeight: 200,
    hoverEffects: {
        opacity: 1,
        scale: 1.05,
        rotate: 0,
        rotateMode: "2D" as const,
        skewX: 0,
        skewY: 0,
        offsetX: 0,
        offsetY: 0,
    },
    hoverTransition: {
        type: "spring",
        stiffness: 930,
        damping: 30,
    },
    pressEffects: {
        opacity: 1,
        scale: 0.95,
        rotate: 0,
        rotateMode: "2D" as const,
        skewX: 0,
        skewY: 0,
        offsetX: 0,
        offsetY: 0,
    },
    dragStateEffects: {
        scale: 0.92,
        zoomOutAmount: 0.88,
        zoomTransitionSpeed: 0.25,
    },
    zoomOutSpring: { stiffness: 500, damping: 40, mass: 1 },
    zoomInSpring: { stiffness: 400, damping: 35, mass: 1 },
    baseVelocity: 0.5,
    overflowVisible: false,
}

addPropertyControls(SkewedInfiniteScroll, {
    images: {
        type: ControlType.Array,
        title: "Images",
        control: {
            type: ControlType.Object,
            controls: {
                src: {
                    type: ControlType.ResponsiveImage,
                    title: "Image",
                },
                alt: { type: ControlType.String, title: "Alt Text" },
                width: {
                    type: ControlType.Number,
                    title: "Width",
                    min: 50,
                    max: 800,
                    step: 10,
                    defaultValue: 220,
                    description:
                        "Custom width (only used when Force Size is OFF)",
                },
                height: {
                    type: ControlType.Number,
                    title: "Height",
                    min: 50,
                    max: 600,
                    step: 10,
                    defaultValue: 160,
                    description:
                        "Custom height (only used when Force Size is OFF)",
                },
                href: { type: ControlType.Link, title: "Link" },
                cursorVariant: {
                    type: ControlType.String,
                    title: "Cursor Variant",
                    placeholder: "Image1, Nature, Drift, etc.",
                    description: "Variant name for cursor (optional)",
                },
                hoverText: {
                    type: ControlType.String,
                    title: "Hover Text",
                    placeholder: "DRIFT/IMAGES, NATURE/STUDIES, etc.",
                    description: "Text to show when hovering this image",
                },
            },
        },
    },
    numCards: {
        type: ControlType.Number,
        title: "Cards",
        defaultValue: 100,
        min: 1,
        max: 200,
        step: 1,
        displayStepper: true,
    },
    baseVelocity: {
        type: ControlType.Number,
        title: "Auto-Scroll",
        defaultValue: 0.5,
    },

    gap: {
        type: ControlType.Number,
        title: "Gap",
        defaultValue: 40,
    },
    skew: {
        type: ControlType.Number,
        title: "Skew",
        defaultValue: -10,
    },
    diagonalSpread: {
        type: ControlType.Number,
        title: "Spread",
        defaultValue: 1.2,
    },
    diagonalAngle: {
        type: ControlType.Number,
        title: "Direction Angle",
        defaultValue: 225,
        min: 0,
        max: 360,
        step: 1,
        unit: "°",
        description:
            "Angle of diagonal movement (0° = right, 90° = down, 180° = left, 270° = up)",
    },
    xOffset: {
        type: ControlType.Number,
        title: "X-Offset",
        defaultValue: 0,
    },
    overflowVisible: {
        type: ControlType.Boolean,
        title: "Overflow",
        defaultValue: false,
    },

    forceDefaultSize: {
        type: ControlType.Boolean,
        title: "Force Default Size",
        defaultValue: false,
        description:
            "When ON: Uses default size for all cards. When OFF: Uses individual image Width/Height settings above.",
    },
    defaultCardWidth: {
        type: ControlType.Number,
        title: "Default Width",
        defaultValue: 220,
        min: 50,
        max: 800,
        step: 10,
        hidden: (props: any) => !props.forceDefaultSize,
        description: "Default width when Force Default Size is ON",
    },
    defaultCardHeight: {
        type: ControlType.Number,
        title: "Default Height",
        defaultValue: 160,
        min: 50,
        max: 600,
        step: 10,
        hidden: (props: any) => !props.forceDefaultSize,
        description: "Default height when Force Default Size is ON",
    },
    debugSizing: {
        type: ControlType.Boolean,
        title: "Debug Sizing",
        defaultValue: false,
        description: "Shows size information overlay for troubleshooting",
    },
    sizeDampening: {
        type: ControlType.Number,
        title: "Size Dampening",
        defaultValue: 0.3,
        min: 0,
        max: 1,
        step: 0.1,
        description:
            "Controls how much size variations affect positioning. 0 = uniform spacing, 1 = full size impact",
    },
    maxPositionWidth: {
        type: ControlType.Number,
        title: "Max Position Width",
        defaultValue: 300,
        min: 200,
        max: 500,
        step: 10,
        description:
            "Maximum width that affects positioning (prevents huge gaps)",
    },
    maxPositionHeight: {
        type: ControlType.Number,
        title: "Max Position Height",
        defaultValue: 200,
        min: 150,
        max: 400,
        step: 10,
        description:
            "Maximum height that affects positioning (prevents huge gaps)",
    },
    scrollPhysics: {
        type: ControlType.Object,
        title: "Scroll Physics",
        controls: {
            power: {
                type: ControlType.Number,
                title: "Scroll Power",
                defaultValue: 1.2,
                min: 0.1,
                max: 5,
                step: 0.1,
            },
            stiffness: {
                type: ControlType.Number,
                title: "Spring Stiffness",
                defaultValue: 150,
                min: 10,
                max: 300,
                step: 5,
            },
            mass: {
                type: ControlType.Number,
                title: "Spring Mass",
                defaultValue: 0.8,
                min: 0.1,
                max: 5,
                step: 0.1,
            },
            damping: {
                type: ControlType.Number,
                title: "Damping",
                defaultValue: 95,
                min: 0,
                max: 100,
            },
            stopThreshold: {
                type: ControlType.Number,
                title: "Stop Threshold",
                defaultValue: 0.01,
                min: 0.001,
                max: 0.1,
                step: 0.001,
            },
            useSpring: {
                type: ControlType.Boolean,
                title: "Use Spring",
                defaultValue: true,
                description:
                    "When off, auto-scroll coasts without spring easing",
            },
        },
    },
    dragSensitivity: {
        type: ControlType.Number,
        title: "Drag Sensitivity",
        defaultValue: 0.8,
        min: 0.1,
        max: 3,
        step: 0.1,
    },
    flingMultiplier: {
        type: ControlType.Number,
        title: "Fling Multiplier",
        defaultValue: 100,
        min: 0,
        max: 300,
    },
    // Interaction Effects
    dragStateEffects: {
        type: ControlType.Object,
        title: "Drag State Effects",
        controls: {
            scale: {
                type: ControlType.Number,
                title: "Overall Scale",
                defaultValue: 0.85,
                min: 0.1,
                max: 1.5,
                step: 0.05,
            },
            zoomOutAmount: {
                type: ControlType.Number,
                title: "Zoom Out Amount",
                defaultValue: 0.85,
                min: 0.1,
                max: 1,
                step: 0.05,
            },
            zoomTransitionSpeed: {
                type: ControlType.Number,
                title: "Zoom Transition Speed",
                defaultValue: 0.3,
                min: 0.1,
                max: 2,
                step: 0.1,
            },
        },
    },
    zoomOutSpring: {
        type: ControlType.Object,
        title: "Zoom Out Animation (Drag Start)",
        controls: {
            stiffness: {
                type: ControlType.Number,
                defaultValue: 500,
                min: 50,
            },
            damping: {
                type: ControlType.Number,
                defaultValue: 40,
                min: 10,
            },
            mass: {
                type: ControlType.Number,
                defaultValue: 1,
                min: 0.1,
                max: 5,
                step: 0.1,
            },
        },
    },
    zoomInSpring: {
        type: ControlType.Object,
        title: "Zoom In Animation (Drag End)",
        controls: {
            stiffness: {
                type: ControlType.Number,
                defaultValue: 400,
                min: 50,
            },
            damping: {
                type: ControlType.Number,
                defaultValue: 35,
                min: 10,
            },
            mass: {
                type: ControlType.Number,
                defaultValue: 1,
                min: 0.1,
                max: 5,
                step: 0.1,
            },
        },
    },
    hoverEffects: {
        type: ControlType.Object,
        title: "Hover Effects",
        controls: {
            opacity: {
                type: ControlType.Number,
                title: "Opacity",
                defaultValue: 1,
                min: 0,
                max: 1,
                step: 0.1,
                displayStepper: true,
            },
            scale: {
                type: ControlType.Number,
                title: "Scale",
                defaultValue: 1.05,
                min: 0.1,
                max: 3,
                step: 0.05,
                displayStepper: true,
            },
            rotate: {
                type: ControlType.Number,
                title: "Rotate",
                defaultValue: 0,
                min: -180,
                max: 180,
                step: 1,
                unit: "deg",
            },
            rotateMode: {
                type: ControlType.Enum,
                title: "Rotation Mode",
                defaultValue: "2D",
                options: ["2D", "3D"],
                optionTitles: ["2D Rotate", "3D Rotate Y"],
            },
            skewX: {
                type: ControlType.Number,
                title: "Skew X",
                defaultValue: 0,
                min: -45,
                max: 45,
                step: 1,
                unit: "deg",
            },
            skewY: {
                type: ControlType.Number,
                title: "Skew Y",
                defaultValue: 0,
                min: -45,
                max: 45,
                step: 1,
                unit: "deg",
            },
            offsetX: {
                type: ControlType.Number,
                title: "Offset X",
                defaultValue: 0,
                min: -100,
                max: 100,
                step: 1,
                unit: "px",
            },
            offsetY: {
                type: ControlType.Number,
                title: "Offset Y",
                defaultValue: 0,
                min: -100,
                max: 100,
                step: 1,
                unit: "px",
            },
        },
    },
    hoverTransition: {
        type: ControlType.Transition,
        title: "Hover Transition",
        defaultValue: {
            type: "spring",
            stiffness: 400,
            damping: 30,
        },
    },
    pressEffects: {
        type: ControlType.Object,
        title: "Press Effects",
        controls: {
            opacity: {
                type: ControlType.Number,
                title: "Opacity",
                defaultValue: 1,
                min: 0,
                max: 1,
                step: 0.1,
                displayStepper: true,
            },
            scale: {
                type: ControlType.Number,
                title: "Scale",
                defaultValue: 0.95,
                min: 0.1,
                max: 3,
                step: 0.05,
                displayStepper: true,
            },
            rotate: {
                type: ControlType.Number,
                title: "Rotate",
                defaultValue: 0,
                min: -180,
                max: 180,
                step: 1,
                unit: "deg",
            },
            rotateMode: {
                type: ControlType.Enum,
                title: "Rotation Mode",
                defaultValue: "2D",
                options: ["2D", "3D"],
                optionTitles: ["2D Rotate", "3D Rotate Y"],
            },
            skewX: {
                type: ControlType.Number,
                title: "Skew X",
                defaultValue: 0,
                min: -45,
                max: 45,
                step: 1,
                unit: "deg",
            },
            skewY: {
                type: ControlType.Number,
                title: "Skew Y",
                defaultValue: 0,
                min: -45,
                max: 45,
                step: 1,
                unit: "deg",
            },
            offsetX: {
                type: ControlType.Number,
                title: "Offset X",
                defaultValue: 0,
                min: -100,
                max: 100,
                step: 1,
                unit: "px",
            },
            offsetY: {
                type: ControlType.Number,
                title: "Offset Y",
                defaultValue: 0,
                min: -100,
                max: 100,
                step: 1,
                unit: "px",
            },
        },
    },
    cardOpacity: {
        type: ControlType.Number,
        title: "Opacity",
        defaultValue: 1,
    },
    entrance: {
        type: ControlType.Boolean,
        title: "Animate In",
        defaultValue: true,
    },
    enableDynamicCursor: {
        type: ControlType.Boolean,
        title: "Dynamic Cursor Text",
        defaultValue: true,
        description:
            "Shows hover text that follows the cursor. Make sure to add 'Hover Text' for each image above!",
    },
    cursorTransition: {
        type: ControlType.Transition,
        title: "Cursor Follow Transition",
        defaultValue: {
            type: "spring",
            stiffness: 400,
            damping: 30,
        },
        description:
            "Native Framer transition for cursor following animation. Try different spring settings!",
    },
})

export default SkewedInfiniteScroll

/**
 * @framerDisableUnlink
 * @framerSupportedLayoutWidth fixed
 * @framerSupportedLayoutHeight fixed
 */
