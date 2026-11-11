package space.xiaokubao.schedule;

import static org.junit.Assert.*;

import org.junit.Test;

public class ExampleUnitTest {

    @Test
    public void addition_isCorrect() throws Exception {
        assertEquals(4, 2 + 2);
    }

    @Test
    public void counterDeltaClampPreservesRepeatedDecrements() {
        assertEquals(-2, CounterStore.clampDelta(-1L + -1L));
        assertEquals(-5, CounterStore.clampDelta(-1L + -1L + -1L + -1L + -1L));
        assertEquals(2, CounterStore.clampDelta(1L + 1L));
        assertEquals(10000, CounterStore.clampDelta(10001L));
        assertEquals(-10000, CounterStore.clampDelta(-10001L));
    }
}
