"""End-to-end checks in a real browser (Playwright, Python): ONE browser, one context
per player. Start a server first, then:

  python tests/e2e/e2e.py local   http://127.0.0.1:3110    # npm start: 2p round, 4p teams, reload, offline bot
  python tests/e2e/e2e.py away    http://127.0.0.1:3110    # a drop, the 60 s hold, a bot takes the seat
  python tests/e2e/e2e.py online  http://127.0.0.1:8794    # wrangler dev: the 2-player round
  python tests/e2e/e2e.py split   http://127.0.0.1:8795 http://127.0.0.1:8794
        # Pages-style: the page from a static server, the rooms from the Worker

Moves are chosen with the page's own rules module and made by clicking the cards and
the Capture / Place buttons, like a player would.
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

PREFS = json.dumps({'labels': 'latin', 'sound': False, 'shake': False, 'animations': False})
errors = []


def new_player(browser, base, label, server=None, block_ws=False, opts=None):
    ctx = browser.new_context(viewport={'width': 412, 'height': 915}, is_mobile=True, has_touch=True)
    init = f"localStorage.setItem('chkobba_prefs', {json.dumps(PREFS)});"
    if opts:
        init += f"localStorage.setItem('chkobba_room_opts', {json.dumps(json.dumps(opts))});"
    ctx.add_init_script(init)
    ws_hits = []
    if server:
        # the Pages copy of server.js points at the Worker; here it points at wrangler dev
        ctx.route('**/server.js', lambda r: r.fulfill(status=200, content_type='application/javascript',
                                                      body=f"window.GAME_SERVER = '{server}';"))
    if block_ws:
        def deny(route):
            ws_hits.append(route.request.url)
            route.abort()

        def deny_ws(ws):
            ws_hits.append(ws.url)
            ws.close()
        ctx.route_web_socket('**/ws*', deny_ws)
        ctx.route('**/api/**', deny)
    page = ctx.new_page()
    if block_ws:
        page.on('websocket', lambda ws: ws_hits.append(ws.url))
    page.on('pageerror', lambda e: errors.append(f'{label}: {e}'))
    page.on('console', lambda m: errors.append(f'{label} console: {m.text}') if m.type == 'error' else None)
    page.goto(base)
    page.wait_for_function('window.app && document.querySelector("#screen-menu, #screen-join")')
    page.label = label
    page.ws_hits = ws_hits
    return ctx, page


def wait_screen(page, name, timeout=15000):
    page.wait_for_selector(f'#screen-{name}.active', timeout=timeout)


def create_room(page, name):
    page.fill('#menu-name', name)
    page.click('#m-create')
    wait_screen(page, 'waiting')
    page.wait_for_function("document.getElementById('w-slots').children.length > 0")
    link = page.inner_text('#w-link').strip()
    code = page.inner_text('#w-code').strip()
    assert link.endswith('/?room=' + code), link
    return code, link


def join_by_link(page, link, name):
    page.goto(link)
    wait_screen(page, 'join')
    page.fill('#j-name', name)
    page.click('#j-go')
    wait_screen(page, 'waiting')


def my_turn(page):
    return page.evaluate("""() => !!app.gameState && app.gameState.phase === 'playing'
        && app.gameState.currentTurn === app.myPlayerId && !app._animating && !app.isSubmittingMove
        && app.net && app.net.status === 'open'""")


def play_turn(page):
    """One legal move through the UI. Returns False if it was not this player's turn."""
    if not my_turn(page):
        return False
    mv = page.evaluate("""() => {
        const gs = app.gameState, hand = app.myHand;
        const m = ChkobaRules.chooseBotMove(hand, gs.tableCards, 'medium', gs.forceCapture);
        return { hand: hand.findIndex((c) => c.id === m.cardId),
                 table: m.captureCardIds.map((id) => gs.tableCards.findIndex((c) => c.id === id)),
                 seq: gs.moveSeq };
    }""")
    page.locator('#hand-cards .card').nth(mv['hand']).click()
    for i in mv['table']:
        page.locator('#table-cards .card').nth(i).click()
    page.locator('#btn-capture' if mv['table'] else '#btn-place').click(timeout=5000)
    # the buttons always come back: on the answer, a refusal or a timeout
    page.wait_for_function(f"() => !app.isSubmittingMove && (!app.gameState || app.gameState.moveSeq > {mv['seq']} || app.gameState.phase !== 'playing')", timeout=10000)
    return True


def phase(page):
    return page.evaluate("() => app.gameState ? app.gameState.phase : null")


def play_until(pages, done, limit=400, what='the goal'):
    t0 = time.time()
    for _ in range(limit):
        if done():
            return
        moved = False
        for p in pages:
            moved = play_turn(p) or moved
        if not moved:
            pages[0].wait_for_timeout(150)
        if time.time() - t0 > 240:
            break
    raise AssertionError(f'did not reach {what}')


def continue_tally(pages):
    """Every player taps through the round-end tally; the next deal must go out."""
    for p in pages:
        p.wait_for_selector('#ov-ceremony.open', timeout=15000)
    for p in pages:
        p.wait_for_function("() => !!app._ceremonyContinue", timeout=15000)
        p.click('#ov-ceremony')
    for p in pages:
        p.wait_for_function("() => app.gameState && app.gameState.phase === 'playing' && app.gameState.roundNum === 0 && app.gameState.deckCount === 40 - 4 - 3 * app.gameState.numPlayers", timeout=15000)


def two_player_round(browser, base, server=None, reload_check=False):
    """(a) a 2-player game through the invite link, to the end of a full round."""
    ca, a = new_player(browser, base, 'A', server)
    cb, b = new_player(browser, base, 'B', server)
    code, link = create_room(a, 'Ana')
    join_by_link(b, link, 'Ben')
    a.wait_for_function("!document.getElementById('w-start').disabled")
    a.click('#w-start')
    wait_screen(a, 'game')
    wait_screen(b, 'game')
    # nobody's browser ever holds another hand: B's state has only B's three cards
    leaked = b.evaluate("() => JSON.stringify(app.snap).includes('\"deck\"') || JSON.stringify(app.snap).includes('\"hands\"')")
    assert not leaked, 'private state reached a client'
    assert b.evaluate("() => app.myHand.length") == 3
    if reload_check:
        # (c) a reload mid-game resumes the same seat and hand
        play_until([a, b], lambda: a.evaluate("() => app.gameState.moveSeq >= 3"), what='three moves')
        a.wait_for_function("() => !app._animating")
        before = b.evaluate("() => ({ seat: app.myPlayerId, hand: app.myHand.map((c) => c.id) })")
        b.reload()
        b.wait_for_function("() => app.gameState && app.snap && app.snap.game", timeout=15000)
        wait_screen(b, 'game')
        after = b.evaluate("() => ({ seat: app.myPlayerId, hand: app.myHand.map((c) => c.id) })")
        assert before == after, f'reload changed the seat or hand: {before} -> {after}'
        a.wait_for_function("() => app.snap.seats[1].connected", timeout=10000)
        print('  (c) reload resumed seat', after['seat'], 'with the same hand', after['hand'])
    play_until([a, b], lambda: phase(a) == 'round_end' or phase(a) == 'finished', what='the end of the round')
    if phase(a) == 'finished':
        print('  match ended early (all ten diamonds)')
    else:
        scores = a.evaluate("() => app.gameState.scores")
        assert sum(scores) >= 1, scores
        continue_tally([a, b])
        print(f'  (a) round played to the end over room {code}: score {scores[0]}-{scores[1]}, next deck dealt')
    ca.close()
    cb.close()


def four_player_teams(browser, base):
    """(b) a 4-player team game for a few turns."""
    players = [new_player(browser, base, f'P{i}', opts={'players': 4, 'winScore': 21, 'timer': 0, 'bot': 'medium',
                                                        'speed': 'fast', 'forceCapture': True, 'captureAssist': False})
               for i in range(4)]
    pages = [p for _, p in players]
    code, link = create_room(pages[0], 'Host')
    for i, p in enumerate(pages[1:], 1):
        join_by_link(p, link, f'Guest{i}')
    pages[0].wait_for_function("!document.getElementById('w-start').disabled")
    pages[0].click('#w-start')
    for p in pages:
        wait_screen(p, 'game')
    teams = pages[0].evaluate("() => app.gameState.players.map((p) => p.team)")
    assert teams == [0, 1, 0, 1], teams
    assert pages[0].inner_text('#hud-t1-name').strip().upper().startswith('TEAM')
    for p in pages:
        assert p.evaluate("() => app.myHand.length") == 3
    play_until(pages, lambda: pages[0].evaluate("() => app.gameState.moveSeq >= 10"), what='ten moves')
    seq = pages[0].evaluate("() => app.gameState.moveSeq")
    caps = pages[0].evaluate("() => app.gameState.capturedCounts")
    print(f'  (b) 4-player teams 0+2 vs 1+3, {seq} moves played, captured {caps}')
    for c, _ in players:
        c.close()


def offline_bot(browser, base):
    """(d) play vs bot with the network to /ws and /api blocked."""
    ctx, page = new_player(browser, base, 'BOT', block_ws=True)
    page.click('#m-bot')
    wait_screen(page, 'game')
    play_until([page], lambda: page.evaluate("() => app.gameState && app.gameState.moveSeq >= 12"), what='twelve moves vs the bot')
    assert page.ws_hits == [], page.ws_hits
    # a reload offers to resume the saved game
    page.reload()
    page.wait_for_selector('#resume-box:not([hidden])', timeout=10000)
    page.click('#m-resume')
    wait_screen(page, 'game')
    play_until([page], lambda: phase(page) in ('round_end', 'finished'), what='the tally vs the bot')
    print('  (d) offline bot game played to the tally, resumed after a reload, no socket opened')
    ctx.close()


def away_flow(browser, base):
    """A dropped player: the reconnect banner, the 60 s seat hold, then a bot takes the seat."""
    ca, a = new_player(browser, base, 'A')
    cb, b = new_player(browser, base, 'B')
    code, link = create_room(a, 'Ana')
    join_by_link(b, link, 'Ben')
    a.wait_for_function("!document.getElementById('w-start').disabled")
    a.click('#w-start')
    wait_screen(a, 'game')
    wait_screen(b, 'game')
    # a network blip: B shows "Reconnecting", then gets the same seat back
    cb.set_offline(True)
    b.evaluate("() => app.net.wake()")   # a dead socket is noticed at once instead of after the ping timeout
    b.wait_for_selector('#net-banner:not([hidden])', timeout=30000)
    cb.set_offline(False)
    b.wait_for_selector('#net-banner', state='hidden', timeout=30000)
    assert b.evaluate("() => app.myPlayerId") == 1
    print('  blip: reconnect banner shown, seat 1 resumed')
    # B leaves for good (the tab closes): A sees the hold count down, then decides
    cb.close()
    a.wait_for_selector('#away-banner:not([hidden])', timeout=60000)
    print('  hold:', a.inner_text('#away-text'))
    a.wait_for_selector('#ov-left.open', timeout=90000)
    a.click('#left-bot')
    a.wait_for_function("() => app.snap.seats[1].takeover && app.gameState.players[1].isBot", timeout=10000)
    play_until([a], lambda: a.evaluate("() => app.gameState.moveSeq >= 6"), what='six moves with the bot in the seat')
    print('  after 60 s: "Let a bot play" handed the seat to a bot and the game went on')
    ca.close()


def main():
    mode, base = sys.argv[1], sys.argv[2].rstrip('/') + '/'
    server = sys.argv[3] if len(sys.argv) > 3 else None
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        try:
            if mode == 'local':
                two_player_round(browser, base, reload_check=True)
                four_player_teams(browser, base)
                offline_bot(browser, base)
            elif mode == 'online':
                two_player_round(browser, base)
            elif mode == 'split':
                two_player_round(browser, base, server=server)
            elif mode == 'away':
                away_flow(browser, base)
        finally:
            browser.close()
    real = [e for e in errors if 'favicon' not in e]
    if real:
        print('browser errors:')
        for e in real:
            print('  ', e)
        sys.exit(1)
    print('ok:', mode)


if __name__ == '__main__':
    main()
